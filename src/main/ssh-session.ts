import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import ssh2 from 'ssh2';
import type { Client as SshClient, ClientChannel, ConnectConfig, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';

import type {
  CreateTerminalResult,
  CreateRemoteEntryInput,
  DeleteRemoteEntryInput,
  ConnectInput,
  ConnectResult,
  ConnectionStatePayload,
  RenameRemoteEntryInput,
  RemoteDirectoryEntry,
  RemoteFilePayload,
  SaveRemoteFileInput,
  SaveRemoteFileResult,
  SearchRemoteFilesInput,
  SearchRemoteFilesResult,
  TerminalEvent,
} from '../shared/contracts';

const DIRECTORY_MASK = 0o040000;
const TYPE_MASK = 0o170000;
const DEFAULT_SEARCH_RESULT_LIMIT = 200;
const READDIR_CACHE_TTL_MS = 5000;
const TERMINAL_FLUSH_INTERVAL_MS = 16;
const OPTIONAL_SPLIT_READY_TIMEOUT_MS = 4000;
const { Client, utils } = ssh2;

type ConnectionListener = (payload: ConnectionStatePayload) => void;
type TerminalListener = (payload: TerminalEvent) => void;

interface CachedDirectoryEntry {
  expiresAt: number;
  entries: RemoteDirectoryEntry[];
}

interface BufferedTerminalOutput {
  data: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ConnectionManagerState {
  auxiliaryState: 'idle' | 'connecting' | 'ready' | 'failed';
  auxiliaryFailureReason: string | null;
}

function isDirectory(mode?: number): boolean {
  return typeof mode === 'number' && (mode & TYPE_MASK) === DIRECTORY_MASK;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLocalName(filePath: string): string {
  return path.basename(filePath) || filePath;
}

function parseKnownHostsLine(line: string): { hosts: string[]; keyType: string; keyData: Buffer } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('|')) {
    return null;
  }

  const [hostField, keyType, keyValue] = trimmed.split(/\s+/, 3);
  if (!hostField || !keyType || !keyValue) {
    return null;
  }

  try {
    return {
      hosts: hostField.split(','),
      keyType,
      keyData: Buffer.from(keyValue, 'base64'),
    };
  } catch {
    return null;
  }
}

function hostMatchesPattern(host: string, port: number, pattern: string): boolean {
  const bracketed = `[${host}]:${port}`;
  if (pattern === host || pattern === bracketed) {
    return true;
  }

  if (pattern.includes('*') || pattern.includes('?')) {
    const regex = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    );
    return regex.test(host) || regex.test(bracketed);
  }

  return false;
}

async function verifyKnownHosts(
  host: string,
  port: number,
  remoteKey: Buffer,
  knownHostsPath: string,
): Promise<boolean> {
  const parsedRemoteKey = utils.parseKey(remoteKey);
  if (parsedRemoteKey instanceof Error) {
    throw new Error(`Unable to parse host key: ${parsedRemoteKey.message}`);
  }

  const remoteParsed = Array.isArray(parsedRemoteKey) ? parsedRemoteKey[0] : parsedRemoteKey;
  const remotePublic = remoteParsed.getPublicSSH();
  const content = await fs.readFile(knownHostsPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const record = parseKnownHostsLine(line);
    if (!record || record.keyType !== remoteParsed.type) {
      continue;
    }

    if (!record.hosts.some((pattern) => hostMatchesPattern(host, port, pattern))) {
      continue;
    }

    if (record.keyData.equals(remotePublic)) {
      return true;
    }
  }

  return false;
}

function buildSearchPreview(lineText: string, startIndex: number, matchLength: number): string {
  const previewStart = Math.max(0, startIndex - 48);
  const previewEnd = Math.min(lineText.length, startIndex + matchLength + 48);
  return lineText.slice(previewStart, previewEnd).trim();
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createSearchFallbackError(message: string): Error & { code: 'SEARCH_FALLBACK' } {
  const error = new Error(message) as Error & { code: 'SEARCH_FALLBACK' };
  error.code = 'SEARCH_FALLBACK';
  return error;
}

function isSearchFallbackError(error: unknown): error is Error & { code: 'SEARCH_FALLBACK' } {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'SEARCH_FALLBACK';
}

export class SshSessionManager {
  private interactiveClient: SshClient | null = null;
  private activeConnectConfig: ConnectConfig | null = null;
  private sftp: SFTPWrapper | null = null;
  private auxiliaryClient: SshClient | null = null;
  private auxiliarySftp: SFTPWrapper | null = null;
  private auxiliaryAttempted = false;
  private filesystemInitPromise: Promise<void> | null = null;
  private connectionManagerState: ConnectionManagerState = {
    auxiliaryState: 'idle',
    auxiliaryFailureReason: null,
  };
  private terminals = new Map<string, ClientChannel>();
  private terminalOutputBuffers = new Map<string, BufferedTerminalOutput>();
  private connectionId: string | null = null;
  private host: string | null = null;
  private state: ConnectionStatePayload = {
    state: 'disconnected',
    message: 'Disconnected',
    filesystemState: 'idle',
  };
  private connectionListeners = new Set<ConnectionListener>();
  private terminalListeners = new Set<TerminalListener>();
  private isClosing = false;
  private directoryCache = new Map<string, CachedDirectoryEntry>();
  private homeDir: string | null = null;

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
      filesystemState: 'idle',
    });

    try {
      const config = await this.buildConnectConfig(input);
      const interactiveClient = await this.createConnectedClient(config);
      this.attachInteractiveClientListeners(interactiveClient);

      this.interactiveClient = interactiveClient;
      this.activeConnectConfig = config;
      this.auxiliaryAttempted = false;
      this.auxiliaryClient = null;
      this.auxiliarySftp = null;
      this.connectionManagerState = {
        auxiliaryState: 'idle',
        auxiliaryFailureReason: null,
      };
      this.filesystemInitPromise = null;
      this.connectionId = randomUUID();
      this.homeDir = null;
      this.directoryCache.clear();
      this.filesystemInitPromise = this.initializePrimaryFilesystem(input.host, input.username);

      this.emitConnectionState({
        state: 'connected',
        message: `Connected to ${input.username}@${input.host}`,
        host: input.host,
        connectionId: this.connectionId,
        filesystemState: 'loading',
      });

      return {
        connectionId: this.connectionId,
        filesystemState: 'loading',
      };
    } catch (error) {
      this.interactiveClient?.removeAllListeners();
      this.interactiveClient?.end();
      this.interactiveClient = null;
      this.activeConnectConfig = null;
      this.sftp = null;
      this.auxiliaryClient?.removeAllListeners();
      this.auxiliaryClient?.end();
      this.auxiliaryClient = null;
      this.auxiliarySftp = null;
      this.auxiliaryAttempted = false;
      this.connectionManagerState = {
        auxiliaryState: 'idle',
        auxiliaryFailureReason: null,
      };
      this.filesystemInitPromise = null;
      this.connectionId = null;
      this.homeDir = null;
      this.directoryCache.clear();
      const message = getErrorMessage(error, 'Unable to connect to the remote host');
      this.emitConnectionState({
        state: 'error',
        message,
        host: input.host,
        filesystemState: 'error',
      });
      throw new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.isClosing = true;

    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    for (const buffered of this.terminalOutputBuffers.values()) {
      if (buffered.timer) {
        clearTimeout(buffered.timer);
      }
    }
    this.terminalOutputBuffers.clear();
    for (const terminal of terminals) {
      terminal.removeAllListeners();
      terminal.end();
    }

    const interactiveClient = this.interactiveClient;
    this.interactiveClient = null;
    this.activeConnectConfig = null;
    this.sftp = null;
    const auxiliaryClient = this.auxiliaryClient;
    this.auxiliaryClient = null;
    this.auxiliarySftp = null;
    this.auxiliaryAttempted = false;
    this.connectionManagerState = {
      auxiliaryState: 'idle',
      auxiliaryFailureReason: null,
    };
    this.filesystemInitPromise = null;
    this.connectionId = null;
    this.host = null;
    this.homeDir = null;
    this.directoryCache.clear();

    if (interactiveClient) {
      interactiveClient.removeAllListeners();
      interactiveClient.end();
    }

    if (auxiliaryClient) {
      auxiliaryClient.removeAllListeners();
      auxiliaryClient.end();
    }

    this.emitConnectionState({
      state: 'disconnected',
      message: 'Disconnected',
      filesystemState: 'idle',
    });

    this.isClosing = false;
  }

  async readDir(remotePath: string): Promise<RemoteDirectoryEntry[]> {
    const cached = this.directoryCache.get(remotePath);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.entries;
    }

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

    const nextEntries = entries
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

    this.directoryCache.set(remotePath, {
      entries: nextEntries,
      expiresAt: Date.now() + READDIR_CACHE_TTL_MS,
    });

    return nextEntries;
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

      this.invalidateDirectoryCache(input.parentPath);

      return {
        name: input.name,
        path: targetPath,
        kind: 'directory',
      };
    }

    await this.writeRemoteFile(targetPath, '');
    this.invalidateDirectoryCache(input.parentPath);

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
    this.invalidateDirectoryCache(path.posix.dirname(input.path));
    this.invalidateDirectoryCache(input.path);
    this.invalidateDirectoryCache(targetPath);

    return {
      name: input.nextName,
      path: targetPath,
      kind: isDirectory(stats.mode) ? 'directory' : 'file',
      size: typeof stats.size === 'number' ? stats.size : undefined,
      modifiedAt: typeof stats.mtime === 'number' ? stats.mtime * 1000 : undefined,
    };
  }

  async deleteEntry(input: DeleteRemoteEntryInput): Promise<void> {
    await this.deleteRemotePath(input.path);
    this.invalidateDirectoryCache(path.posix.dirname(input.path));
    this.invalidateDirectoryCache(input.path);
  }

  async uploadLocalEntries(localPaths: string[], remotePath: string): Promise<void> {
    if (localPaths.length === 0) {
      return;
    }

    const sftp = await this.getTransferSftp();
    for (const localPath of localPaths) {
      const stats = await fs.stat(localPath);
      const targetPath = path.posix.join(remotePath, normalizeLocalName(localPath));
      if (stats.isDirectory()) {
        await this.uploadLocalDirectory(localPath, targetPath, sftp);
      } else if (stats.isFile()) {
        await this.uploadLocalFile(localPath, targetPath, sftp);
      }
    }

    this.invalidateDirectoryCache(remotePath);
  }

  async downloadEntry(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getTransferSftp();
    const stats = await this.statPath(remotePath, sftp);
    if (isDirectory(stats.mode)) {
      await this.downloadDirectory(remotePath, localPath, sftp);
      return;
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await pipeline(this.createRemoteReadStream(remotePath, sftp), createWriteStream(localPath));
  }

  async searchInFiles(input: SearchRemoteFilesInput): Promise<SearchRemoteFilesResult> {
    const query = input.query.trim();
    if (query === '') {
      return {
        query,
        matches: [],
        truncated: false,
      };
    }

    const normalizedInput: SearchRemoteFilesInput = {
      ...input,
      query,
      rootPath: input.rootPath.trim() || '/',
    };

    try {
      return await this.searchInFilesWithRipgrep(normalizedInput);
    } catch (error) {
      if (!isSearchFallbackError(error)) {
        throw new Error(getErrorMessage(error, `Unable to search in ${normalizedInput.rootPath}`));
      }
    }

    return this.searchInFilesByScanning(normalizedInput);
  }

  private async searchInFilesByScanning(input: SearchRemoteFilesInput): Promise<SearchRemoteFilesResult> {
    const maxResults = input.maxResults ?? DEFAULT_SEARCH_RESULT_LIMIT;
    const regex = new RegExp(escapeRegExp(input.query), input.caseSensitive ? 'g' : 'gi');
    const matches: SearchRemoteFilesResult['matches'] = [];
    let truncated = false;

    const visit = async (remotePath: string): Promise<void> => {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }

      const stats = await this.statPath(remotePath);
      if (isDirectory(stats.mode)) {
        const entries = await this.readDir(remotePath);
        for (const entry of entries) {
          await visit(entry.path);
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
        return;
      }

      const file = await this.readFile(remotePath);
      const lines = file.content.split(/\r?\n/);

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const lineText = lines[lineIndex] ?? '';
        regex.lastIndex = 0;
        let match = regex.exec(lineText);
        while (match) {
          matches.push({
            path: remotePath,
            line: lineIndex + 1,
            column: match.index + 1,
            preview: buildSearchPreview(lineText, match.index, match[0]?.length ?? input.query.length),
          });

          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }

          if ((match[0] ?? '') === '') {
            regex.lastIndex += 1;
          }
          match = regex.exec(lineText);
        }
      }
    };

    await visit(input.rootPath);

    return {
      query: input.query,
      matches,
      truncated,
    };
  }

  async createTerminal(): Promise<CreateTerminalResult> {
    const client = this.requireInteractiveClient();
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

      this.bufferTerminalOutput(terminalId, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    terminal.stderr.on('data', (chunk: Buffer | string) => {
      if (this.terminals.get(terminalId) !== terminal) {
        return;
      }

      this.bufferTerminalOutput(terminalId, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    terminal.on('close', () => {
      if (this.terminals.get(terminalId) !== terminal) {
        return;
      }

      this.flushTerminalOutput(terminalId);
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

      this.flushTerminalOutput(terminalId);
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
    this.flushTerminalOutput(terminalId);
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

  private requireInteractiveClient(): SshClient {
    if (!this.interactiveClient) {
      throw new Error('No active SSH connection');
    }

    return this.interactiveClient;
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

  private async buildConnectConfig(input: ConnectInput): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: input.host.trim(),
      port: input.port,
      username: input.username.trim(),
      readyTimeout: 15000,
    };

    const authMethod = input.authMethod ?? 'password';
    const hostVerification = input.hostVerification ?? 'off';

    if (hostVerification === 'knownHosts') {
      const knownHostsPath = input.knownHostsPath?.trim() ?? '';
      if (knownHostsPath === '') {
        throw new Error('known_hosts path is required when host verification is enabled');
      }

      config.hostVerifier = (hostKey: Buffer, verify: (matched: boolean) => void) => {
        void verifyKnownHosts(config.host!, config.port!, hostKey, knownHostsPath)
          .then((matched) => {
            verify(matched);
          })
          .catch(() => {
            verify(false);
          });
      };
    }

    if (authMethod === 'privateKey') {
      const privateKeyPath = input.privateKeyPath?.trim() ?? '';
      if (privateKeyPath === '') {
        throw new Error('Private key path is required');
      }

      config.privateKey = await fs.readFile(privateKeyPath, 'utf8');
      if ((input.passphrase ?? '').trim() !== '') {
        config.passphrase = input.passphrase;
      }
      return config;
    }

    if (authMethod === 'agent') {
      const agentSocket = input.agentSocket?.trim() ?? '';
      if (agentSocket === '') {
        throw new Error('Agent socket is required');
      }

      config.agent = agentSocket;
      return config;
    }

    config.password = input.password;
    return config;
  }

  private async searchInFilesWithRipgrep(input: SearchRemoteFilesInput): Promise<SearchRemoteFilesResult> {
    const client = await this.getSearchClient();
    const maxResults = input.maxResults ?? DEFAULT_SEARCH_RESULT_LIMIT;
    const command = this.buildRipgrepSearchCommand(input);

    return new Promise<SearchRemoteFilesResult>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(createSearchFallbackError(getErrorMessage(error, 'Unable to start ripgrep')));
          return;
        }

        let settled = false;
        let buffer = '';
        let stderr = '';
        let truncated = false;
        let stoppedEarly = false;
        const matches: SearchRemoteFilesResult['matches'] = [];

        const rejectOnce = (nextError: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          reject(nextError);
        };

        const resolveOnce = (result: SearchRemoteFilesResult) => {
          if (settled) {
            return;
          }

          settled = true;
          resolve(result);
        };

        const stopEarly = () => {
          if (stoppedEarly) {
            return;
          }

          stoppedEarly = true;
          truncated = true;
          (stream as ClientChannel & { signal?: (signalName: string) => void }).signal?.('TERM');
          stream.end();
        };

        const appendMatch = (match: SearchRemoteFilesResult['matches'][number]) => {
          if (matches.length < maxResults) {
            matches.push(match);
            return;
          }

          stopEarly();
        };

        const processJsonLine = (line: string) => {
          const trimmedLine = line.trim();
          if (trimmedLine === '' || settled) {
            return;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(trimmedLine);
          } catch {
            rejectOnce(createSearchFallbackError('Remote ripgrep does not support JSON output'));
            return;
          }

          if (
            typeof payload !== 'object' ||
            payload === null ||
            (payload as { type?: string }).type !== 'match'
          ) {
            return;
          }

          const data = (payload as {
            data?: {
              path?: { text?: string };
              lines?: { text?: string };
              line_number?: number;
              submatches?: Array<{ start?: number; end?: number }>;
            };
          }).data;
          const relativePath = data?.path?.text;
          if (!relativePath) {
            return;
          }

          const remotePath = relativePath.startsWith('/')
            ? relativePath
            : path.posix.join(input.rootPath, relativePath);
          const lineText = (data?.lines?.text ?? '').replace(/\r?\n$/, '');
          const lineNumber = typeof data?.line_number === 'number' ? data.line_number : 1;
          const submatches =
            data?.submatches && data.submatches.length > 0
              ? data.submatches
              : [{ start: 0, end: input.query.length }];

          for (const submatch of submatches) {
            const startIndex = typeof submatch.start === 'number' ? submatch.start : 0;
            const endIndex =
              typeof submatch.end === 'number' ? submatch.end : startIndex + input.query.length;

            appendMatch({
              path: remotePath,
              line: lineNumber,
              column: startIndex + 1,
              preview: buildSearchPreview(
                lineText,
                startIndex,
                Math.max(1, endIndex - startIndex),
              ),
            });

            if (stoppedEarly) {
              return;
            }
          }
        };

        stream.on('data', (chunk: Buffer | string) => {
          if (settled) {
            return;
          }

          buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            processJsonLine(line);
            if (settled) {
              return;
            }
            newlineIndex = buffer.indexOf('\n');
          }
        });

        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });

        stream.on('error', (streamError: Error) => {
          rejectOnce(createSearchFallbackError(getErrorMessage(streamError, 'ripgrep failed')));
        });

        stream.on('close', (exitCode: number | null) => {
          if (settled) {
            return;
          }

          if (buffer.trim() !== '') {
            processJsonLine(buffer);
            if (settled) {
              return;
            }
          }

          if (stoppedEarly) {
            resolveOnce({
              query: input.query,
              matches: matches.slice(0, maxResults),
              truncated: true,
            });
            return;
          }

          const trimmedStderr = stderr.trim();
          if (exitCode === 0 || exitCode === 1 || (matches.length > 0 && trimmedStderr === '')) {
            resolveOnce({
              query: input.query,
              matches,
              truncated,
            });
            return;
          }

          if (
            exitCode === 127 ||
            /command not found|not found|unknown option|unrecognized flag|invalid option/i.test(trimmedStderr)
          ) {
            rejectOnce(createSearchFallbackError(trimmedStderr || 'ripgrep is unavailable on the remote host'));
            return;
          }

          rejectOnce(new Error(trimmedStderr || `ripgrep exited with code ${exitCode ?? 'unknown'}`));
        });
      });
    });
  }

  private buildRipgrepSearchCommand(input: SearchRemoteFilesInput): string {
    const parts = [
      'rg',
      '--json',
      '--line-number',
      '--column',
      '--fixed-strings',
      '--hidden',
      '--no-ignore',
      '--no-messages',
      '--glob',
      quoteForShell('!.git'),
      '--glob',
      quoteForShell('!**/.git/**'),
    ];

    if (!input.caseSensitive) {
      parts.push('--ignore-case');
    }

    parts.push('--', quoteForShell(input.query), quoteForShell(input.rootPath));
    return parts.join(' ');
  }

  private buildTemporaryPath(remotePath: string): string {
    const directory = path.posix.dirname(remotePath);
    const fileName = path.posix.basename(remotePath);
    return path.posix.join(directory, `.${fileName}.tmp-${Date.now()}`);
  }

  private async writeRemoteFile(remotePath: string, content: string, sftp?: SFTPWrapper): Promise<void> {
    const targetSftp = sftp ?? this.requireSftp();

    await new Promise<void>((resolve, reject) => {
      targetSftp.writeFile(remotePath, content, { encoding: 'utf8', mode: 0o644 }, (error?: Error | null) => {
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

  private async statPath(remotePath: string, sftp?: SFTPWrapper): Promise<Stats> {
    const targetSftp = sftp ?? this.requireSftp();

    return new Promise((resolve, reject) => {
      targetSftp.stat(remotePath, (error: Error | undefined, stats) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stats);
      });
    });
  }

  private async lstatPath(remotePath: string): Promise<Stats> {
    const sftp = this.requireSftp();

    return new Promise((resolve, reject) => {
      sftp.lstat(remotePath, (error: Error | undefined, stats) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stats);
      });
    });
  }

  private createRemoteReadStream(remotePath: string, sftp?: SFTPWrapper) {
    const targetSftp = sftp ?? this.requireSftp();
    return targetSftp.createReadStream(remotePath);
  }

  private createRemoteWriteStream(remotePath: string, sftp?: SFTPWrapper) {
    const targetSftp = sftp ?? this.requireSftp();
    return targetSftp.createWriteStream(remotePath, { mode: 0o644 });
  }

  private async ensureRemoteDirectory(remotePath: string, sftp?: SFTPWrapper): Promise<void> {
    const targetSftp = sftp ?? this.requireSftp();
    const normalized = path.posix.normalize(remotePath);
    const parts = normalized.split('/').filter(Boolean);
    let current = normalized.startsWith('/') ? '/' : '';

    for (const part of parts) {
      current = current === '/' ? `/${part}` : path.posix.join(current, part);
      try {
        const stats = await this.statPath(current, targetSftp);
        if (!isDirectory(stats.mode)) {
          throw new Error(`${current} exists and is not a directory`);
        }
      } catch (error) {
        const message = getErrorMessage(error, '');
        if (!/no such file/i.test(message)) {
          try {
            const stats = await this.statPath(current, targetSftp);
            if (!isDirectory(stats.mode)) {
              throw new Error(`${current} exists and is not a directory`);
            }
            continue;
          } catch {
            throw error;
          }
        }

        await new Promise<void>((resolve, reject) => {
          targetSftp.mkdir(current, (mkdirError?: Error | null) => {
            if (mkdirError && !/failure/i.test(mkdirError.message)) {
              reject(mkdirError);
              return;
            }
            resolve();
          });
        });
      }
    }
  }

  private async uploadLocalFile(localPath: string, remotePath: string, sftp?: SFTPWrapper): Promise<void> {
    const targetSftp = sftp ?? this.requireSftp();
    await this.ensureRemoteDirectory(path.posix.dirname(remotePath), targetSftp);
    await pipeline(createReadStream(localPath), this.createRemoteWriteStream(remotePath, targetSftp));
  }

  private async uploadLocalDirectory(localPath: string, remotePath: string, sftp?: SFTPWrapper): Promise<void> {
    const targetSftp = sftp ?? this.requireSftp();
    await this.ensureRemoteDirectory(remotePath, targetSftp);
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextLocalPath = path.join(localPath, entry.name);
      const nextRemotePath = path.posix.join(remotePath, entry.name);
      if (entry.isDirectory()) {
        await this.uploadLocalDirectory(nextLocalPath, nextRemotePath, targetSftp);
      } else if (entry.isFile()) {
        await this.uploadLocalFile(nextLocalPath, nextRemotePath, targetSftp);
      }
    }
  }

  private async downloadDirectory(remotePath: string, localPath: string, sftp?: SFTPWrapper): Promise<void> {
    const targetSftp = sftp ?? this.requireSftp();
    await fs.mkdir(localPath, { recursive: true });
    const entries = await this.readDirWithSftp(remotePath, targetSftp);
    for (const entry of entries) {
      const nextLocalPath = path.join(localPath, entry.name);
      if (entry.kind === 'directory') {
        await this.downloadDirectory(entry.path, nextLocalPath, targetSftp);
      } else {
        await fs.mkdir(path.dirname(nextLocalPath), { recursive: true });
        await pipeline(this.createRemoteReadStream(entry.path, targetSftp), createWriteStream(nextLocalPath));
      }
    }
  }

  private async readDirWithSftp(remotePath: string, sftp: SFTPWrapper): Promise<RemoteDirectoryEntry[]> {
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

  private async deleteRemotePath(remotePath: string): Promise<void> {
    const stats = await this.lstatPath(remotePath);
    if (isDirectory(stats.mode)) {
      const entries = await this.readDir(remotePath);
      for (const entry of entries) {
        await this.deleteRemotePath(entry.path);
      }

      await new Promise<void>((resolve, reject) => {
        this.requireSftp().rmdir(remotePath, (error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.requireSftp().unlink(remotePath, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async createSftp(client: SshClient): Promise<SFTPWrapper> {
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

  private async createConnectedClient(config: ConnectConfig): Promise<SshClient> {
    const client = new Client();

    const ready = new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });

    client.connect(config);
    await ready;
    return client;
  }

  private async initializePrimaryFilesystem(host: string, username: string): Promise<void> {
    try {
      const interactiveClient = this.requireInteractiveClient();
      const sftp = await this.createSftp(interactiveClient);
      if (this.interactiveClient !== interactiveClient || this.isClosing) {
        return;
      }

      this.sftp = sftp;
      const homeDir = await this.resolveHomeDirectory();
      if (this.interactiveClient !== interactiveClient || this.isClosing) {
        return;
      }

      this.homeDir = homeDir;
      this.emitConnectionState({
        ...this.state,
        state: 'connected',
        message: `Connected to ${username}@${host}`,
        host,
        connectionId: this.connectionId ?? undefined,
        homeDir,
        filesystemState: 'ready',
      });
    } catch (error) {
      if (!this.interactiveClient || this.isClosing) {
        return;
      }

      this.sftp = null;
      this.homeDir = null;
      this.emitConnectionState({
        ...this.state,
        state: 'connected',
        message: getErrorMessage(error, 'Remote file system unavailable'),
        host,
        connectionId: this.connectionId ?? undefined,
        filesystemState: 'error',
      });
    } finally {
      this.filesystemInitPromise = null;
    }
  }

  private async createConnectedClientWithTimeout(config: ConnectConfig, timeoutMs: number): Promise<SshClient> {
    return new Promise<SshClient>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        client.removeAllListeners();
        client.end();
        reject(new Error('Timed out while waiting for handshake'));
      }, timeoutMs);

      const settleError = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        client.removeAllListeners();
        client.end();
        reject(error);
      };

      client.once('ready', () => {
        if (settled) {
          client.removeAllListeners();
          client.end();
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolve(client);
      });
      client.once('error', (error) => {
        settleError(error);
      });
      client.once('close', () => {
        settleError(new Error('Connection lost before handshake'));
      });
      client.once('end', () => {
        settleError(new Error('Connection ended before handshake'));
      });

      client.connect(config);
    });
  }

  private attachInteractiveClientListeners(client: SshClient): void {
    client.on('close', () => {
      this.handleRemoteDisconnect('Connection closed');
    });

    client.on('end', () => {
      this.handleRemoteDisconnect('Connection ended');
    });

    client.on('error', (error: Error) => {
      if (this.state.state === 'connected') {
        this.emitConnectionState({
          ...this.state,
          state: 'error',
          message: getErrorMessage(error, 'SSH connection error'),
          host: this.host ?? undefined,
          connectionId: this.connectionId ?? undefined,
        });
      }
    });
  }

  private async tryInitializeAuxiliarySession(config: ConnectConfig, host: string, username: string): Promise<void> {
    if (this.auxiliaryAttempted || !this.interactiveClient || !this.connectionId) {
      return;
    }

    this.auxiliaryAttempted = true;
    this.connectionManagerState.auxiliaryState = 'connecting';
    this.connectionManagerState.auxiliaryFailureReason = null;

    try {
      const client = await this.createConnectedClientWithTimeout(config, OPTIONAL_SPLIT_READY_TIMEOUT_MS);
      if (!this.interactiveClient || !this.connectionId || this.isClosing) {
        client.removeAllListeners();
        client.end();
        return;
      }

      const sftp = await this.createSftp(client);
      this.auxiliaryClient = client;
      this.auxiliarySftp = sftp;
      this.connectionManagerState.auxiliaryState = 'ready';
      this.connectionManagerState.auxiliaryFailureReason = null;

      client.on('close', () => {
        this.handleAuxiliaryDisconnect('Auxiliary SSH session closed');
      });
      client.on('end', () => {
        this.handleAuxiliaryDisconnect('Auxiliary SSH session ended');
      });
      client.on('error', (error: Error) => {
        this.handleAuxiliaryDisconnect(getErrorMessage(error, 'Auxiliary SSH session error'));
      });

      console.info(`Auxiliary SSH session ready for ${username}@${host}`);
    } catch (error) {
      const message = getErrorMessage(error, 'Auxiliary SSH session unavailable');
      this.connectionManagerState.auxiliaryState = 'failed';
      this.connectionManagerState.auxiliaryFailureReason = message;
      console.warn(`Auxiliary SSH session unavailable for ${username}@${host}:`, error);
      this.auxiliaryClient = null;
      this.auxiliarySftp = null;
    }
  }

  private invalidateDirectoryCache(remotePath: string): void {
    const normalizedPath = path.posix.normalize(remotePath);
    if (normalizedPath === '/') {
      this.directoryCache.clear();
      return;
    }

    for (const key of [...this.directoryCache.keys()]) {
      if (key === normalizedPath || key.startsWith(`${normalizedPath}/`)) {
        this.directoryCache.delete(key);
      }
    }
  }

  private bufferTerminalOutput(terminalId: string, chunk: string): void {
    const buffered = this.terminalOutputBuffers.get(terminalId) ?? {
      data: '',
      timer: null,
    };
    buffered.data += chunk;

    if (!buffered.timer) {
      buffered.timer = setTimeout(() => {
        this.flushTerminalOutput(terminalId);
      }, TERMINAL_FLUSH_INTERVAL_MS);
    }

    this.terminalOutputBuffers.set(terminalId, buffered);
  }

  private flushTerminalOutput(terminalId: string): void {
    const buffered = this.terminalOutputBuffers.get(terminalId);
    if (!buffered) {
      return;
    }

    if (buffered.timer) {
      clearTimeout(buffered.timer);
      buffered.timer = null;
    }

    if (buffered.data !== '') {
      this.emitTerminalEvent({
        type: 'data',
        terminalId,
        data: buffered.data,
      });
    }

    this.terminalOutputBuffers.delete(terminalId);
  }

  private async getSearchClient(): Promise<SshClient> {
    await this.ensureAuxiliaryConnection();
    return this.auxiliaryClient ?? this.requireInteractiveClient();
  }

  private async getTransferSftp(): Promise<SFTPWrapper> {
    await this.ensureAuxiliaryConnection();
    return this.auxiliarySftp ?? this.requireSftp();
  }

  private async ensureAuxiliaryConnection(): Promise<void> {
    if (!this.interactiveClient || !this.connectionId) {
      return;
    }

    if (this.connectionManagerState.auxiliaryState === 'ready' || this.connectionManagerState.auxiliaryState === 'failed') {
      return;
    }

    if (this.connectionManagerState.auxiliaryState === 'connecting') {
      return;
    }

    const config = this.buildCurrentConnectConfigSnapshot();
    if (!config) {
      return;
    }

    await this.tryInitializeAuxiliarySession(config, this.host ?? config.host ?? 'unknown-host', config.username ?? 'unknown-user');
  }

  private buildCurrentConnectConfigSnapshot(): ConnectConfig | null {
    const config = this.activeConnectConfig;
    if (!config) {
      return null;
    }

    return {
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
      agent: config.agent,
      readyTimeout: config.readyTimeout,
      hostVerifier: config.hostVerifier,
    };
  }

  private handleAuxiliaryDisconnect(message: string): void {
    if (this.isClosing) {
      return;
    }

    if (this.auxiliaryClient) {
      this.auxiliaryClient.removeAllListeners();
      this.auxiliaryClient.end();
    }
    this.auxiliaryClient = null;
    this.auxiliarySftp = null;
    this.connectionManagerState.auxiliaryState = 'failed';
    this.connectionManagerState.auxiliaryFailureReason = message;
    console.warn(message);
  }

  private handleRemoteDisconnect(message: string): void {
    if (this.isClosing) {
      return;
    }

    const terminalIds = [...this.terminals.keys()];
    for (const terminalId of terminalIds) {
      this.flushTerminalOutput(terminalId);
    }
    this.interactiveClient = null;
    this.activeConnectConfig = null;
    this.sftp = null;
    if (this.auxiliaryClient) {
      this.auxiliaryClient.removeAllListeners();
      this.auxiliaryClient.end();
    }
    this.auxiliaryClient = null;
    this.auxiliarySftp = null;
    this.auxiliaryAttempted = false;
    this.terminals.clear();
    this.homeDir = null;
    this.directoryCache.clear();

    this.emitConnectionState({
      state: 'disconnected',
      message,
      host: this.host ?? undefined,
      connectionId: this.connectionId ?? undefined,
      filesystemState: 'idle',
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
