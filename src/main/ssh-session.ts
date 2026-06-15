import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'ssh2';
import type { ClientChannel, FileEntryWithStats, SFTPWrapper } from 'ssh2';

import type {
  CreateTerminalResult,
  CreateRemoteEntryInput,
  ConnectInput,
  ConnectResult,
  ConnectionStatePayload,
  RenameRemoteEntryInput,
  RemoteDirectoryEntry,
  RemoteFilePayload,
  SaveRemoteFileInput,
  SaveRemoteFileResult,
  TerminalEvent,
} from '../shared/contracts';

const DIRECTORY_MASK = 0o040000;
const TYPE_MASK = 0o170000;

type ConnectionListener = (payload: ConnectionStatePayload) => void;
type TerminalListener = (payload: TerminalEvent) => void;

function isDirectory(mode?: number): boolean {
  return typeof mode === 'number' && (mode & TYPE_MASK) === DIRECTORY_MASK;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

export class SshSessionManager {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private terminals = new Map<string, ClientChannel>();
  private connectionId: string | null = null;
  private host: string | null = null;
  private state: ConnectionStatePayload = {
    state: 'disconnected',
    message: 'Disconnected',
  };
  private connectionListeners = new Set<ConnectionListener>();
  private terminalListeners = new Set<TerminalListener>();
  private isClosing = false;

  onConnectionState(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.state);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  onTerminalEvent(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    await this.disconnect();

    this.host = input.host;
    this.emitConnectionState({
      state: 'connecting',
      message: `Connecting to ${input.host}:${input.port}...`,
      host: input.host,
    });

    const client = new Client();

    const ready = new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });

    client.on('close', () => {
      this.handleRemoteDisconnect('Connection closed');
    });

    client.on('end', () => {
      this.handleRemoteDisconnect('Connection ended');
    });

    client.on('error', (error: Error) => {
      if (this.state.state === 'connected') {
        this.emitConnectionState({
          state: 'error',
          message: getErrorMessage(error, 'SSH connection error'),
          host: this.host ?? undefined,
          connectionId: this.connectionId ?? undefined,
        });
      }
    });

    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        readyTimeout: 15000,
      });

      await ready;

      this.client = client;
      this.connectionId = randomUUID();
      this.sftp = await this.createSftp(client);

      this.emitConnectionState({
        state: 'connected',
        message: `Connected to ${input.username}@${input.host}`,
        host: input.host,
        connectionId: this.connectionId,
      });

      const homeDir = await this.resolveHomeDirectory();

      return {
        connectionId: this.connectionId,
        homeDir,
      };
    } catch (error) {
      client.removeAllListeners();
      client.end();
      this.client = null;
      this.sftp = null;
      this.connectionId = null;
      const message = getErrorMessage(error, 'Unable to connect to the remote host');
      this.emitConnectionState({
        state: 'error',
        message,
        host: input.host,
      });
      throw new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.isClosing = true;

    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    for (const terminal of terminals) {
      terminal.removeAllListeners();
      terminal.end();
    }

    const client = this.client;
    this.client = null;
    this.sftp = null;
    this.connectionId = null;
    this.host = null;

    if (client) {
      client.removeAllListeners();
      client.end();
    }

    this.emitConnectionState({
      state: 'disconnected',
      message: 'Disconnected',
    });

    this.isClosing = false;
  }

  async readDir(remotePath: string): Promise<RemoteDirectoryEntry[]> {
    const sftp = this.requireSftp();

    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(remotePath, (error: Error | undefined, items: FileEntryWithStats[]) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(items ?? []);
      });
    });

    return entries
      .filter((entry: FileEntryWithStats) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry: FileEntryWithStats): RemoteDirectoryEntry => ({
        name: entry.filename,
        path: path.posix.join(remotePath, entry.filename),
        kind: isDirectory(entry.attrs.mode) ? 'directory' : 'file',
        size: typeof entry.attrs.size === 'number' ? entry.attrs.size : undefined,
        modifiedAt: typeof entry.attrs.mtime === 'number' ? entry.attrs.mtime * 1000 : undefined,
      }))
      .sort((left: RemoteDirectoryEntry, right: RemoteDirectoryEntry) => {
        if (left.kind !== right.kind) {
          return left.kind === 'directory' ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
  }

  async readFile(remotePath: string): Promise<RemoteFilePayload> {
    const sftp = this.requireSftp();

    const content = await new Promise<string>((resolve, reject) => {
      const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
      let buffer = '';

      stream.on('data', (chunk: string) => {
        buffer += chunk;
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(buffer));
    });

    return {
      path: remotePath,
      content,
    };
  }

  async writeFileAtomic(input: SaveRemoteFileInput): Promise<SaveRemoteFileResult> {
    const sftp = this.requireSftp();
    const temporaryPath = this.buildTemporaryPath(input.path);

    try {
      await this.writeRemoteFile(temporaryPath, input.content);

      try {
        await this.openSshRename(temporaryPath, input.path);
      } catch (renameError) {
        try {
          await this.unlinkIfExists(input.path);
          await this.renamePath(temporaryPath, input.path);
        } catch (fallbackError) {
          try {
            await this.writeRemoteFile(input.path, input.content);
            await this.unlinkIfExists(temporaryPath);
          } catch (directWriteError) {
            throw new Error(
              `${getErrorMessage(renameError, 'rename failed')}; ${getErrorMessage(
                fallbackError,
                'replace failed',
              )}; ${getErrorMessage(directWriteError, 'direct write failed')}`,
            );
          }
        }
      }

      return {
        path: input.path,
        savedAt: new Date().toISOString(),
      };
    } catch (error) {
      await new Promise<void>((resolve) => {
        sftp.unlink(temporaryPath, () => resolve());
      });
      throw new Error(getErrorMessage(error, `Unable to save ${input.path}`));
    }
  }

  async createEntry(input: CreateRemoteEntryInput): Promise<RemoteDirectoryEntry> {
    const targetPath = path.posix.join(input.parentPath, input.name);
    const sftp = this.requireSftp();

    if (input.kind === 'directory') {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(targetPath, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      return {
        name: input.name,
        path: targetPath,
        kind: 'directory',
      };
    }

    await this.writeRemoteFile(targetPath, '');

    return {
      name: input.name,
      path: targetPath,
      kind: 'file',
      size: 0,
    };
  }

  async renameEntry(input: RenameRemoteEntryInput): Promise<RemoteDirectoryEntry> {
    const targetPath = path.posix.join(path.posix.dirname(input.path), input.nextName);

    try {
      await this.openSshRename(input.path, targetPath);
    } catch {
      await this.renamePath(input.path, targetPath);
    }

    const stats = await this.statPath(targetPath);

    return {
      name: input.nextName,
      path: targetPath,
      kind: isDirectory(stats.mode) ? 'directory' : 'file',
      size: typeof stats.size === 'number' ? stats.size : undefined,
      modifiedAt: typeof stats.mtime === 'number' ? stats.mtime * 1000 : undefined,
    };
  }

  async createTerminal(): Promise<CreateTerminalResult> {
    const client = this.requireClient();
    const terminalId = randomUUID();

    const terminal = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: 120,
          rows: 32,
        },
        (error: Error | undefined, stream: ClientChannel) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(stream);
        },
      );
    });

    this.terminals.set(terminalId, terminal);

    terminal.on('data', (chunk: Buffer | string) => {
      if (this.terminals.get(terminalId) !== terminal) {
        return;
      }

      this.emitTerminalEvent({
        type: 'data',
        terminalId,
        data: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      });
    });

    terminal.stderr.on('data', (chunk: Buffer | string) => {
      if (this.terminals.get(terminalId) !== terminal) {
        return;
      }

      this.emitTerminalEvent({
        type: 'data',
        terminalId,
        data: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      });
    });

    terminal.on('close', () => {
      if (this.terminals.get(terminalId) !== terminal) {
        return;
      }

      this.terminals.delete(terminalId);

      this.emitTerminalEvent({
        type: 'exit',
        terminalId,
      });
    });

    terminal.on('error', (error: Error) => {
      if (this.terminals.get(terminalId) !== terminal) {
        return;
      }

      this.emitTerminalEvent({
        type: 'error',
        terminalId,
        message: getErrorMessage(error, 'Terminal session error'),
      });
    });

    return { terminalId };
  }

  async writeTerminal(terminalId: string, data: string): Promise<void> {
    const terminal = this.requireTerminal(terminalId);
    terminal.write(data);
  }

  async resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    const terminal = this.requireTerminal(terminalId);
    terminal.setWindow(rows, cols, 0, 0);
  }

  async closeTerminal(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    this.terminals.delete(terminalId);
    if (!terminal) {
      return;
    }

    terminal.removeAllListeners();
    terminal.end();
    this.emitTerminalEvent({
      type: 'exit',
      terminalId,
    });
  }

  private emitConnectionState(payload: ConnectionStatePayload): void {
    this.state = payload;
    for (const listener of this.connectionListeners) {
      listener(payload);
    }
  }

  private emitTerminalEvent(payload: TerminalEvent): void {
    for (const listener of this.terminalListeners) {
      listener(payload);
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error('No active SSH connection');
    }

    return this.client;
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new Error('No active SFTP session');
    }

    return this.sftp;
  }

  private requireTerminal(terminalId: string): ClientChannel {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error('No active terminal session');
    }

    return terminal;
  }

  private buildTemporaryPath(remotePath: string): string {
    const directory = path.posix.dirname(remotePath);
    const fileName = path.posix.basename(remotePath);
    return path.posix.join(directory, `.${fileName}.tmp-${Date.now()}`);
  }

  private async writeRemoteFile(remotePath: string, content: string): Promise<void> {
    const sftp = this.requireSftp();

    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, content, { encoding: 'utf8', mode: 0o644 }, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async renamePath(fromPath: string, toPath: string): Promise<void> {
    const sftp = this.requireSftp();

    await new Promise<void>((resolve, reject) => {
      sftp.rename(fromPath, toPath, (error: Error | null | undefined) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async openSshRename(fromPath: string, toPath: string): Promise<void> {
    const sftp = this.requireSftp();

    await new Promise<void>((resolve, reject) => {
      sftp.ext_openssh_rename(fromPath, toPath, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async unlinkIfExists(remotePath: string): Promise<void> {
    const sftp = this.requireSftp();

    const exists = await new Promise<boolean>((resolve) => {
      sftp.exists(remotePath, (hasError) => {
        resolve(!hasError);
      });
    });

    if (!exists) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      sftp.unlink(remotePath, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async statPath(remotePath: string): Promise<import('ssh2').Stats> {
    const sftp = this.requireSftp();

    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (error: Error | undefined, stats) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stats);
      });
    });
  }

  private async createSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error: Error | undefined, sftp: SFTPWrapper) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(sftp);
      });
    });
  }

  private async resolveHomeDirectory(): Promise<string> {
    const sftp = this.requireSftp();

    try {
      return await new Promise<string>((resolve, reject) => {
        sftp.realpath('.', (error: Error | undefined, absPath: string) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(absPath || '/');
        });
      });
    } catch {
      return '/';
    }
  }

  private handleRemoteDisconnect(message: string): void {
    if (this.isClosing) {
      return;
    }

    const terminalIds = [...this.terminals.keys()];
    this.client = null;
    this.sftp = null;
    this.terminals.clear();

    this.emitConnectionState({
      state: 'disconnected',
      message,
      host: this.host ?? undefined,
      connectionId: this.connectionId ?? undefined,
    });

    for (const terminalId of terminalIds) {
      this.emitTerminalEvent({
        type: 'exit',
        terminalId,
      });
    }

    this.connectionId = null;
  }
}
