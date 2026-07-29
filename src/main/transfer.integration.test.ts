/**
 * End-to-end exercise of the resumable transfer engine against a real ssh2 SFTP
 * server (test-sftp-server.ts) running on loopback. Unlike transfer.test.ts —
 * which unit-tests the pure helpers — this drives the actual SshSessionManager
 * upload/download code paths over the SFTP wire protocol, so it covers the
 * byte-offset streams, `.part` staging + rename, resume-from-offset, and cancel.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectInput, FileOperationEvent } from '../shared/contracts';
import { SshSessionManager } from './ssh-session';
import { startSftpServer, type SftpTestServer } from './test-sftp-server';
import { PART_SUFFIX } from './transfer';

let server: SftpTestServer;
let remoteRoot: string;
let localRoot: string;
let manager: SshSessionManager;
let events: FileOperationEvent[];

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function connectManager(): Promise<void> {
  manager = new SshSessionManager();
  events = [];
  manager.onFileOperationEvent((event) => {
    events.push(event);
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for filesystem to become ready'));
    }, 10_000);
    const unsubscribe = manager.onConnectionState((payload) => {
      if (payload.filesystemState === 'ready') {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });

  const input: ConnectInput = {
    host: '127.0.0.1',
    port: server.port,
    username: 'tester',
    authMethod: 'password',
    password: 'irrelevant',
    hostVerification: 'off',
  };
  await manager.connect(input);
  await ready;
}

beforeEach(async () => {
  remoteRoot = await makeTempDir('ssh-remote-');
  localRoot = await makeTempDir('ssh-local-');
  server = await startSftpServer(remoteRoot);
  // Loopback SSH handshakes can transiently starve when many vitest workers
  // run heavy key exchanges at once; a single retry keeps this deterministic
  // without masking product behaviour (the app's connect path is unchanged).
  try {
    await connectManager();
  } catch {
    await manager?.disconnect().catch(() => undefined);
    await connectManager();
  }
}, 30_000);

afterEach(async () => {
  await manager.disconnect().catch(() => undefined);
  await server.close().catch(() => undefined);
  await fs.rm(remoteRoot, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(localRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('resumable transfer engine (real SFTP)', () => {
  it('uploads a file, reports byte progress, and stages through a .part', async () => {
    const payload = Buffer.alloc(512 * 1024, 7); // 512 KiB
    const localFile = path.join(localRoot, 'dataset.bin');
    await fs.writeFile(localFile, payload);

    const result = await manager.uploadLocalEntries({
      operationId: 'up-1',
      remotePath: '/',
      localPaths: [localFile],
      conflictStrategy: 'overwrite',
    });

    expect(result.status).toBe('completed');

    // Bytes landed intact at the final path, no leftover .part.
    const uploaded = await fs.readFile(path.join(remoteRoot, 'dataset.bin'));
    expect(uploaded.length).toBe(payload.length);
    expect(uploaded.equals(payload)).toBe(true);
    const remoteEntries = await fs.readdir(remoteRoot);
    expect(remoteEntries.some((name) => name.endsWith(PART_SUFFIX))).toBe(false);

    // Progress events carried real byte counts ending at total.
    const running = events.filter((e) => e.operationId === 'up-1' && e.status === 'running');
    const withBytes = running.filter((e) => typeof e.totalBytes === 'number' && e.totalBytes > 0);
    expect(withBytes.length).toBeGreaterThan(0);
    const last = withBytes[withBytes.length - 1];
    expect(last.totalBytes).toBe(payload.length);
    expect(last.transferredBytes).toBe(payload.length);
    expect(last.transport).toBe('sftp');
  });

  it('resumes an upload from an existing .part instead of restarting', async () => {
    const payload = Buffer.alloc(400 * 1024, 3);
    const localFile = path.join(localRoot, 'resume.bin');
    await fs.writeFile(localFile, payload);

    // Pre-seed a partial .part on the remote as if a prior attempt died at
    // 150 KiB — but POISON the prefix with a marker byte the source never uses.
    // If the engine truly resumes it keeps these bytes and streams only the
    // tail, so the poisoned prefix survives. If it restarted from zero it would
    // overwrite them and the file would equal the clean source. This is what
    // distinguishes real byte-level resume from an accidental full restart.
    const alreadyThere = 150 * 1024;
    const poison = Buffer.alloc(alreadyThere, 0xaa);
    await fs.writeFile(path.join(remoteRoot, `resume.bin${PART_SUFFIX}`), poison);

    const result = await manager.uploadLocalEntries({
      operationId: 'up-resume',
      remotePath: '/',
      localPaths: [localFile],
      conflictStrategy: 'overwrite',
    });
    expect(result.status).toBe('completed');

    const uploaded = await fs.readFile(path.join(remoteRoot, 'resume.bin'));
    expect(uploaded.length).toBe(payload.length);
    // Poisoned prefix preserved → the engine resumed, it did not restart.
    expect(uploaded.subarray(0, alreadyThere).equals(poison)).toBe(true);
    // Tail beyond the resume offset was streamed fresh from the source.
    expect(uploaded.subarray(alreadyThere).equals(payload.subarray(alreadyThere))).toBe(true);

    // The pre-existing bytes were also accounted as already-transferred so the
    // bar/ETA reflect remaining work: a byte-carrying event reaches the offset
    // without the operation having streamed the whole file from zero.
    const withBytes = events.filter(
      (e) => e.operationId === 'up-resume' && typeof e.transferredBytes === 'number',
    );
    expect(withBytes.some((e) => (e.transferredBytes ?? 0) >= alreadyThere)).toBe(true);
    const finalByteEvent = withBytes[withBytes.length - 1];
    expect(finalByteEvent.transferredBytes).toBe(payload.length);
  });

  it('cancel mid-upload keeps the .part so a later run resumes', async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 9); // 4 MiB, big enough to cancel mid-flight
    const localFile = path.join(localRoot, 'big.bin');
    await fs.writeFile(localFile, payload);

    // Cancel as soon as we see the first byte-carrying progress event.
    const unsubscribe = manager.onFileOperationEvent((event) => {
      if (
        event.operationId === 'cancel-1' &&
        event.status === 'running' &&
        typeof event.transferredBytes === 'number' &&
        event.transferredBytes > 0
      ) {
        manager.cancelFileOperation('cancel-1');
      }
    });

    const result = await manager.uploadLocalEntries({
      operationId: 'cancel-1',
      remotePath: '/',
      localPaths: [localFile],
      conflictStrategy: 'overwrite',
    });
    unsubscribe();

    // Operation resolves without throwing and surfaces a canceled event.
    expect(result.status).toBe('completed');
    const canceled = events.find((e) => e.operationId === 'cancel-1' && e.status === 'canceled');
    expect(canceled).toBeDefined();

    // The final file was NOT produced, but a .part survives for resume.
    const remoteEntries = await fs.readdir(remoteRoot);
    expect(remoteEntries).toContain(`big.bin${PART_SUFFIX}`);
    expect(remoteEntries).not.toContain('big.bin');
  });

  it('downloads a file with byte progress and stages through a local .part', async () => {
    const payload = Buffer.alloc(256 * 1024, 5);
    await fs.writeFile(path.join(remoteRoot, 'out.bin'), payload);
    const localTarget = path.join(localRoot, 'out.bin');

    const result = await manager.downloadEntry({
      operationId: 'down-1',
      remotePath: '/out.bin',
      localPath: localTarget,
      conflictStrategy: 'overwrite',
    });
    expect(result.status).toBe('completed');

    const downloaded = await fs.readFile(localTarget);
    expect(downloaded.equals(payload)).toBe(true);
    const localEntries = await fs.readdir(localRoot);
    expect(localEntries.some((name) => name.endsWith(PART_SUFFIX))).toBe(false);

    const withBytes = events.filter(
      (e) => e.operationId === 'down-1' && typeof e.transferredBytes === 'number' && e.totalBytes,
    );
    expect(withBytes.length).toBeGreaterThan(0);
    const last = withBytes[withBytes.length - 1];
    expect(last.transferredBytes).toBe(payload.length);
    expect(last.totalBytes).toBe(payload.length);
  });

  it('resumes a download from a partial local .part (append, no re-fetch)', async () => {
    const payload = Buffer.alloc(300 * 1024, 2);
    await fs.writeFile(path.join(remoteRoot, 'dl-resume.bin'), payload);

    // Poison the local partial: on a true append-resume the engine keeps these
    // bytes and only fetches the tail, so the poison survives. A restart would
    // truncate and re-download, yielding the clean payload.
    const localTarget = path.join(localRoot, 'dl-resume.bin');
    const alreadyThere = 120 * 1024;
    const poison = Buffer.alloc(alreadyThere, 0xbb);
    await fs.writeFile(`${localTarget}${PART_SUFFIX}`, poison);

    const result = await manager.downloadEntry({
      operationId: 'down-resume',
      remotePath: '/dl-resume.bin',
      localPath: localTarget,
      conflictStrategy: 'overwrite',
    });
    expect(result.status).toBe('completed');

    const downloaded = await fs.readFile(localTarget);
    expect(downloaded.length).toBe(payload.length);
    expect(downloaded.subarray(0, alreadyThere).equals(poison)).toBe(true);
    expect(downloaded.subarray(alreadyThere).equals(payload.subarray(alreadyThere))).toBe(true);

    const withBytes = events.filter(
      (e) => e.operationId === 'down-resume' && typeof e.transferredBytes === 'number',
    );
    expect(withBytes.some((e) => (e.transferredBytes ?? 0) >= alreadyThere)).toBe(true);
    const finalByteEvent = withBytes[withBytes.length - 1];
    expect(finalByteEvent.transferredBytes).toBe(payload.length);
  });
});
