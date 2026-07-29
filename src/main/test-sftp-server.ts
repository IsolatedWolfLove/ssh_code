/**
 * A minimal but protocol-correct in-process SFTP server backed by a real
 * directory on disk. It implements enough of the SFTP surface for the transfer
 * engine to run for real: OPEN (r / w / r+ / a with byte offset), READ,
 * WRITE (at offset), FSTAT, STAT, LSTAT, FSETSTAT/SETSTAT, RENAME, REMOVE,
 * MKDIR, RMDIR, OPENDIR, READDIR, REALPATH and CLOSE.
 *
 * This exists so `ssh-session` upload/download/resume/cancel can be exercised
 * end to end against a genuine ssh2 SFTP wire exchange in unit tests, without a
 * real remote host. It is test-support code, not shipped in the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import ssh2, { type Attributes, type FileEntry } from 'ssh2';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

interface FileHandle {
  type: 'file';
  fd: number;
  path: string;
}
interface DirHandle {
  type: 'dir';
  path: string;
  read: boolean;
}
type Handle = FileHandle | DirHandle;

export interface SftpTestServer {
  port: number;
  close: () => Promise<void>;
}

function statsToAttrs(stats: fs.Stats): Attributes {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

export async function startSftpServer(rootDir: string): Promise<SftpTestServer> {
  await fsp.mkdir(rootDir, { recursive: true });
  const hostKey = utils.generateKeyPairSync('ed25519').private;

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, Handle>();
          let handleCounter = 0;

          const makeHandle = (payload: Handle): Buffer => {
            const id = handleCounter++;
            handles.set(id, payload);
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id, 0);
            return buf;
          };
          const readHandleId = (handleBuf: Buffer): number => handleBuf.readUInt32BE(0);

          // Resolve an SFTP path against the sandbox root. The engine sends
          // absolute paths rooted at whatever REALPATH reports ("/").
          const resolve = (p: string): string => {
            const normalized = path.posix.normalize('/' + p).replace(/^\/+/, '');
            return path.join(rootDir, normalized);
          };

          sftp.on('REALPATH', (reqid, givenPath) => {
            let virtual = path.posix.normalize(givenPath || '.');
            if (virtual === '.') virtual = '/';
            sftp.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} as Attributes }]);
          });

          sftp.on('OPEN', (reqid, filename, flags) => {
            const target = resolve(filename);
            let fsFlags = 'r';
            if (flags & OPEN_MODE.WRITE && flags & OPEN_MODE.READ) {
              fsFlags = flags & OPEN_MODE.CREAT ? 'w+' : 'r+';
            } else if (flags & OPEN_MODE.WRITE) {
              if (flags & OPEN_MODE.APPEND) fsFlags = 'a';
              else if (flags & OPEN_MODE.TRUNC) fsFlags = 'w';
              else if (flags & OPEN_MODE.CREAT) fsFlags = 'w';
              else fsFlags = 'r+';
            } else {
              fsFlags = 'r';
            }
            fs.open(target, fsFlags, 0o644, (err, fd) => {
              if (err) {
                sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                return;
              }
              sftp.handle(reqid, makeHandle({ type: 'file', fd, path: target }));
            });
          });

          sftp.on('READ', (reqid, handleBuf, offset, length) => {
            const h = handles.get(readHandleId(handleBuf));
            if (!h || h.type !== 'file') {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            const buf = Buffer.alloc(length);
            fs.read(h.fd, buf, 0, length, offset, (err, bytesRead) => {
              if (err) {
                sftp.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
              if (bytesRead === 0) {
                sftp.status(reqid, STATUS_CODE.EOF);
                return;
              }
              sftp.data(reqid, buf.subarray(0, bytesRead));
            });
          });

          sftp.on('WRITE', (reqid, handleBuf, offset, data) => {
            const h = handles.get(readHandleId(handleBuf));
            if (!h || h.type !== 'file') {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            fs.write(h.fd, data, 0, data.length, offset, (err) => {
              sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
            });
          });

          sftp.on('FSTAT', (reqid, handleBuf) => {
            const h = handles.get(readHandleId(handleBuf));
            if (!h || h.type !== 'file') {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            fs.fstat(h.fd, (err, stats) => {
              if (err) {
                sftp.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
              sftp.attrs(reqid, statsToAttrs(stats));
            });
          });

          const doStat = (reqid: number, p: string): void => {
            fs.stat(resolve(p), (err, stats) => {
              if (err) {
                sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                return;
              }
              sftp.attrs(reqid, statsToAttrs(stats));
            });
          };
          sftp.on('STAT', doStat);
          sftp.on('LSTAT', doStat);

          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

          sftp.on('RENAME', (reqid, oldPath, newPath) => {
            fs.rename(resolve(oldPath), resolve(newPath), (err) => {
              sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
            });
          });

          sftp.on('REMOVE', (reqid, p) => {
            fs.unlink(resolve(p), (err) => {
              sftp.status(reqid, err ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.OK);
            });
          });

          sftp.on('MKDIR', (reqid, p) => {
            fs.mkdir(resolve(p), { recursive: false }, (err) => {
              sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
            });
          });
          sftp.on('RMDIR', (reqid, p) => {
            fs.rmdir(resolve(p), (err) => {
              sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
            });
          });

          sftp.on('OPENDIR', (reqid, p) => {
            const target = resolve(p);
            fs.stat(target, (err, stats) => {
              if (err || !stats.isDirectory()) {
                sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
                return;
              }
              sftp.handle(reqid, makeHandle({ type: 'dir', path: target, read: false }));
            });
          });

          sftp.on('READDIR', (reqid, handleBuf) => {
            const h = handles.get(readHandleId(handleBuf));
            if (!h || h.type !== 'dir') {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            if (h.read) {
              sftp.status(reqid, STATUS_CODE.EOF);
              return;
            }
            h.read = true;
            fs.readdir(h.path, (err, names) => {
              if (err) {
                sftp.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
              const list: FileEntry[] = names.map((name) => {
                let attrs: Attributes = {} as Attributes;
                try {
                  attrs = statsToAttrs(fs.statSync(path.join(h.path, name)));
                } catch {
                  // leave default attrs
                }
                return { filename: name, longname: name, attrs };
              });
              sftp.name(reqid, list);
            });
          });

          sftp.on('CLOSE', (reqid, handleBuf) => {
            const id = readHandleId(handleBuf);
            const h = handles.get(id);
            if (h && h.type === 'file') {
              fs.close(h.fd, () => undefined);
            }
            handles.delete(id);
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
