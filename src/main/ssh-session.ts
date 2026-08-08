import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { lstat as fsLstat } from 'node:fs/promises';
import net, { type AddressInfo, type Server as NetServer, type Socket as NetSocket } from 'node:net';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import ssh2 from 'ssh2';
import type {
  Client as SshClient,
  ClientChannel,
  ConnectConfig,
  FileEntryWithStats,
  SFTPWrapper,
  Stats,
} from 'ssh2';

import type {
  CreateTerminalInput,
  CreateTerminalResult,
  CreateRemoteEntryInput,
  HostMetricsEvent,
  HostMetricsSnapshot,
  PersistentShellKind,
  ReadRemoteBinaryFileInput,
  RemoteBinaryFilePayload,
  RemoteShellSupport,
  DeleteRemoteEntryInput,
  ConnectInput,
  ConnectResult,
    ConnectionStatePayload,
    ConnectionDiagnosticCode,
    RenameRemoteEntryInput,
    RemoteDirectoryEntry,
    RemoteFilePayload,
    SavedDynamicTunnelConfig,
    SavedLocalTunnelConfig,
    SavedRemoteTunnelConfig,
    SavedTunnelConfig,
    SaveRemoteFileInput,
    SaveRemoteFileResult,
    SearchRemoteFilesInput,
    SearchRemoteFilesResult,
    FileConflictItem,
    FileConflictStrategy,
    FileOperationEvent,
    FileOperationResult,
    LanguageServerDiagnosticsEvent,
    LanguageServerDocumentChangeInput,
    LanguageServerDocumentInput,
    LanguageServerDocumentReference,
    LanguageServerFeatureInput,
    LanguageServerStateEvent,
    UploadLocalEntriesInput,
    DownloadRemoteEntryInput,
    TerminalEvent,
    TunnelEvent,
    TunnelRuntimeState,
    TunnelSnapshot,
    EnsureVirtualDisplayResult,
    StartVideoStreamInput,
    StartVideoStreamResult,
    StartLanguageServerInput,
    StartLanguageServerResult,
    VideoFrameEvent,
    VideoStreamStateEvent,
    EnableVisionModeResult,
  } from '../shared/contracts';
import { buildMetricsCommand, parseMetricsOutput } from './host-metrics';
import { IdleTransferManager } from './idle-transfer';
import { RemoteLanguageServerManager } from './language-server-manager';
import {
  buildAttachCommand,
  buildKillSessionCommand,
  buildListSessionsCommand,
  buildSetSessionEnvCommand,
  buildSupportProbeCommand,
  normalizeSessionName,
  parseSessionList,
  parseSupportProbe,
} from './persistent-shell';
import { quoteForShell } from './shell';
import { PART_SUFFIX, RateEstimator, resolveResumeOffset, toPartPath } from './transfer';

const DIRECTORY_MASK = 0o040000;
const TYPE_MASK = 0o170000;
const DEFAULT_SEARCH_RESULT_LIMIT = 200;
const READDIR_CACHE_TTL_MS = 5000;
const TERMINAL_FLUSH_INTERVAL_MS = 16;
const OPTIONAL_SPLIT_READY_TIMEOUT_MS = 4000;
const VISION_DEFAULT_DISPLAY = ':99';
const VISION_DISPLAY_CHECK_TIMEOUT_MS = 8000;
// Common absolute install locations for a distro-packaged ffmpeg, checked before
// falling back to whatever `ffmpeg` resolves to on the remote user's PATH. This
// avoids picking up a ffmpeg from an active conda/venv environment that was built
// without x11grab support (common with conda-forge's ffmpeg package).
const FFMPEG_CANDIDATE_PATHS = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
const HOST_METRICS_DEFAULT_INTERVAL_MS = 4000;
const HOST_METRICS_MIN_INTERVAL_MS = 1000;
// Previews are decoded in-memory in the renderer, so cap what a single request
// can pull over SFTP. Result plots and sample images are far below this.
const BINARY_FILE_DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
// Byte-progress events would otherwise fire on every chunk (thousands per second
// on a fast link). Throttle IPC to a rate the UI can actually paint; the final
// state for each file is always emitted regardless.
const TRANSFER_PROGRESS_THROTTLE_MS = 250;
const { Client, utils } = ssh2;

type ConnectionListener = (payload: ConnectionStatePayload) => void;
type TerminalListener = (payload: TerminalEvent) => void;
type TunnelListener = (payload: TunnelEvent) => void;
type FileOperationListener = (payload: FileOperationEvent) => void;
type VideoFrameListener = (payload: VideoFrameEvent) => void;
type VideoStreamStateListener = (payload: VideoStreamStateEvent) => void;
type LanguageServerDiagnosticsListener = (payload: LanguageServerDiagnosticsEvent) => void;
type LanguageServerStateListener = (payload: LanguageServerStateEvent) => void;
type HostMetricsListener = (payload: HostMetricsEvent) => void;

interface HostMetricsPoller {
  timer: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  workspacePath: string;
  inFlight: boolean;
  stopped: boolean;
}

interface ActiveVideoStreamSession {
  channel: ClientChannel;
  buffer: Buffer;
  seq: number;
}

interface CachedDirectoryEntry {
  expiresAt: number;
  entries: RemoteDirectoryEntry[];
}

interface BufferedTerminalOutput {
  data: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ConnectionManagerState {
  auxiliaryState: 'idle' | 'connecting' | 'ready' | 'failed';
  auxiliaryFailureReason: string | null;
}

interface TerminalSession {
  client: SshClient;
  channel: ClientChannel;
  /** Set when this shell is attached to a tmux/screen session on the host. */
  sessionName?: string;
  persistentKind?: PersistentShellKind;
}

interface FileOperationProgress {
  operationId: string;
  kind: FileOperationEvent['kind'];
  sourcePath: string;
  targetPath: string;
  totalItems: number;
  completedItems: number;
  skippedItems: number;
  totalBytes: number;
  transferredBytes: number;
  transport: FileOperationEvent['transport'];
  rate: RateEstimator;
  lastEmitAt: number;
  canceled: boolean;
}

interface LocalPathSummary {
  files: number;
  directories: number;
  bytes: number;
}

// Tracks the live streams behind an in-flight upload/download so a cancel
// request can tear them down mid-file. The `.part` file is intentionally left on
// disk so the next attempt resumes from where this one stopped.
interface ActiveTransfer {
  cancel(): void;
}

interface TransferSftpHandle {
  sftp: SFTPWrapper | null;
  viaShell: boolean;
}

interface ConnectionDiagnostic {
  code: ConnectionDiagnosticCode;
  message: string;
  recoveryHint: string;
  recoverable: boolean;
}

interface ConnectMetadata {
  authMethod: NonNullable<ConnectInput['authMethod']>;
}

interface LocalTunnelSession {
  kind: 'local' | 'dynamic';
  config: SavedLocalTunnelConfig | SavedDynamicTunnelConfig;
  server: NetServer;
  sockets: Set<NetSocket>;
  channels: Set<ClientChannel>;
}

interface RemoteTunnelSession {
  kind: 'remote';
  config: SavedRemoteTunnelConfig;
  sockets: Set<NetSocket>;
  channels: Set<ClientChannel>;
}

type ActiveTunnelSession = LocalTunnelSession | RemoteTunnelSession;

interface RemoteTunnelConnectionInfo {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
}

type RemoteTunnelAccept = () => ClientChannel;
type RemoteTunnelReject = () => void;

function isDirectory(mode?: number): boolean {
  return typeof mode === 'number' && (mode & TYPE_MASK) === DIRECTORY_MASK;
}

// Thrown when a transfer is torn down by an explicit cancel request, so the
// caller can report `canceled` instead of `failed` and keep the `.part` file.
class TransferCanceledError extends Error {
  constructor() {
    super('Transfer canceled');
    this.name = 'TransferCanceledError';
  }
}

/**
 * A passthrough that reports how many bytes flowed through it. Placing this in
 * the transfer pipeline is what turns whole-file streaming into byte-granular
 * progress without buffering the payload.
 */
function createByteCounter(onBytes: (chunk: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/i);
  return match ? match[0].replace(/[),.;]+$/, '') : null;
}

function classifyConnectionError(error: unknown): ConnectionDiagnostic {
  const message = getErrorMessage(error, 'Unable to connect to the remote host');
  const lower = message.toLowerCase();

  if (
    lower.includes('all configured authentication methods failed') ||
    lower.includes('permission denied') ||
    lower.includes('auth fail') ||
    lower.includes('authentication failed')
  ) {
    const wrongPassword = lower.includes('password');
    return {
      code: wrongPassword ? 'wrongPassword' : 'authenticationFailed',
      message: wrongPassword ? 'Password authentication failed' : 'SSH authentication failed',
      recoveryHint: wrongPassword ? 'Check the password and username.' : 'Check the selected authentication method and credentials.',
      recoverable: true,
    };
  }

  if (
    lower.includes('host verification failed') ||
    lower.includes('host key') ||
    lower.includes('known_hosts') ||
    lower.includes('fingerprint')
  ) {
    return {
      code: 'knownHosts',
      message: 'Host verification failed',
      recoveryHint: 'Check the known_hosts path or update the host key entry.',
      recoverable: true,
    };
  }

  if (
    lower.includes('private key') ||
    lower.includes('passphrase') ||
    lower.includes('agent socket is required') ||
    lower.includes('cannot parse privatekey')
  ) {
    return {
      code: 'privateKey',
      message: 'Private key authentication failed',
      recoveryHint: 'Check the key path, key format, and passphrase.',
      recoverable: true,
    };
  }

  if (
    lower.includes('timed out') ||
    lower.includes('ehostunreach') ||
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('network is unreachable') ||
    lower.includes('no route to host')
  ) {
    if (lower.includes('timed out') && lower.includes('handshake')) {
      return {
        code: 'authenticationFailed',
        message: 'Timed out while waiting for Tailscale SSH verification',
        recoveryHint: 'Open the login link and complete the browser check before the timeout expires.',
        recoverable: true,
      };
    }
    return {
      code: 'hostUnreachable',
      message: 'Host unreachable',
      recoveryHint: 'Check the host, port, network path, and whether SSH is listening.',
      recoverable: true,
    };
  }

  return {
    code: 'unknown',
    message,
    recoveryHint: 'Check the connection settings and SSH server logs.',
    recoverable: true,
  };
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

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function buildSearchPreview(lineText: string, startIndex: number, matchLength: number): string {
  const previewStart = Math.max(0, startIndex - 48);
  const previewEnd = Math.min(lineText.length, startIndex + matchLength + 48);
  return lineText.slice(previewStart, previewEnd).trim();
}

function createSearchFallbackError(message: string): Error & { code: 'SEARCH_FALLBACK' } {
  const error = new Error(message) as Error & { code: 'SEARCH_FALLBACK' };
  error.code = 'SEARCH_FALLBACK';
  return error;
}

function isSearchFallbackError(error: unknown): error is Error & { code: 'SEARCH_FALLBACK' } {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'SEARCH_FALLBACK';
}

function buildRemoteTunnelKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function destroySocket(socket: NetSocket): void {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function destroyChannel(channel: ClientChannel): void {
  channel.removeAllListeners();
  channel.stderr.removeAllListeners();
  channel.on('error', () => undefined);
  channel.stderr.on('error', () => undefined);
  channel.destroy();
}

export class SshSessionManager {
  private interactiveClient: SshClient | null = null;
  private jumpClient: SshClient | null = null;
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
  private terminals = new Map<string, TerminalSession>();
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
  private tunnelListeners = new Set<TunnelListener>();
  private fileOperationListeners = new Set<FileOperationListener>();
  private activeTunnels = new Map<string, ActiveTunnelSession>();
  private tunnelStates = new Map<string, TunnelRuntimeState>();
  private remoteTunnelBindings = new Map<string, string>();
  private isClosing = false;
  private directoryCache = new Map<string, CachedDirectoryEntry>();
  private homeDir: string | null = null;
  private activeConnectMetadata: ConnectMetadata | null = null;
  private videoFrameListeners = new Set<VideoFrameListener>();
  private videoStreamStateListeners = new Set<VideoStreamStateListener>();
  private videoStreams = new Map<string, ActiveVideoStreamSession>();
  private visionModeDisplay: string | null = null;
  private resolvedFfmpegPath: string | null = null;
  private languageServers = new RemoteLanguageServerManager();
  private hostMetricsListeners = new Set<HostMetricsListener>();
  private hostMetricsPoller: HostMetricsPoller | null = null;
  private persistentShellKind: PersistentShellKind | null = null;
  private activeTransfers = new Map<string, ActiveTransfer>();
  private remoteRsyncAvailable: boolean | null = null;
  private idleTransfers = new IdleTransferManager({
    stat: async (remotePath) => {
      const stats = await this.statPath(remotePath, this.requireSftp());
      return {
        kind: isDirectory(stats.mode) ? 'directory' : 'file',
        size: typeof stats.size === 'number' ? stats.size : 0,
        modifiedAt: typeof stats.mtime === 'number' ? stats.mtime * 1000 : undefined,
      };
    },
    readDir: (remotePath) => this.readDirWithSftp(remotePath, this.requireSftp()),
    createReadStream: (remotePath) => this.requireSftp().createReadStream(remotePath),
  });

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

  onTunnelEvent(listener: TunnelListener): () => void {
    this.tunnelListeners.add(listener);
    return () => {
      this.tunnelListeners.delete(listener);
    };
  }

  onFileOperationEvent(listener: FileOperationListener): () => void {
    this.fileOperationListeners.add(listener);
    return () => {
      this.fileOperationListeners.delete(listener);
    };
  }

  onVideoFrameEvent(listener: VideoFrameListener): () => void {
    this.videoFrameListeners.add(listener);
    return () => {
      this.videoFrameListeners.delete(listener);
    };
  }

  onVideoStreamStateEvent(listener: VideoStreamStateListener): () => void {
    this.videoStreamStateListeners.add(listener);
    return () => {
      this.videoStreamStateListeners.delete(listener);
    };
  }

  onHostMetricsEvent(listener: HostMetricsListener): () => void {
    this.hostMetricsListeners.add(listener);
    return () => {
      this.hostMetricsListeners.delete(listener);
    };
  }

  onLanguageServerDiagnostics(listener: LanguageServerDiagnosticsListener): () => void {
    return this.languageServers.onDiagnostics(listener);
  }

  onLanguageServerState(listener: LanguageServerStateListener): () => void {
    return this.languageServers.onState(listener);
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
      if (input.jumpHost) {
        const jumpConfig = await this.buildConnectConfig({
          ...input,
          ...input.jumpHost,
          hostVerification: 'off',
          knownHostsPath: '',
          jumpHost: undefined,
        });
        this.jumpClient = await this.createConnectedClient(jumpConfig);
        config.sock = await this.createJumpStream(this.jumpClient, config.host!, config.port!);
      }
      const interactiveClient = await this.createConnectedClient(config, {
        authMethod: input.authMethod ?? 'password',
      });
      this.attachInteractiveClientListeners(interactiveClient);

      this.interactiveClient = interactiveClient;
      this.activeConnectConfig = config;
      this.activeConnectMetadata = {
        authMethod: input.authMethod ?? 'password',
      };
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
      await this.idleTransfers.startSession();
      this.filesystemInitPromise = this.initializePrimaryFilesystem(input.host, input.username);

      this.emitConnectionState({
        state: 'connected',
        message: `Connected to ${input.username}@${input.host}`,
        host: input.host,
        connectionId: this.connectionId,
        filesystemState: 'loading',
        authUrl: undefined,
      });

      return {
        connectionId: this.connectionId,
        filesystemState: 'loading',
      };
    } catch (error) {
      this.interactiveClient?.removeAllListeners();
      this.interactiveClient?.end();
      this.interactiveClient = null;
      this.jumpClient?.removeAllListeners();
      this.jumpClient?.end();
      this.jumpClient = null;
      this.activeConnectConfig = null;
      this.activeConnectMetadata = null;
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
      await this.idleTransfers.stopSession();
      const diagnostic = classifyConnectionError(error);
      this.emitConnectionState({
        state: 'error',
        message: `${diagnostic.message}. ${diagnostic.recoveryHint}`,
        host: input.host,
        filesystemState: 'error',
        reason: 'connectFailed',
        diagnosticCode: diagnostic.code,
        recoveryHint: diagnostic.recoveryHint,
        recoverable: diagnostic.recoverable,
        authUrl: undefined,
      });
      // Keep the driver error available to callers; the diagnostic category is
      // useful for the UI, but the original text identifies paths, passphrases,
      // and agent/socket failures that need different recovery actions.
      const originalMessage = getErrorMessage(error, 'Unknown SSH error');
      throw new Error(`${diagnostic.message}. ${diagnostic.recoveryHint} (${originalMessage})`);
    }
  }

  async disconnect(): Promise<void> {
    this.isClosing = true;

    this.stopHostMetrics();
    await this.idleTransfers.stopSession();
    this.persistentShellKind = null;
    await this.languageServers.stopAll();
    await this.stopAllTunnels();

    const videoStreamIds = [...this.videoStreams.keys()];
    for (const streamId of videoStreamIds) {
      await this.stopVideoStream(streamId).catch(() => undefined);
    }
    this.visionModeDisplay = null;
    this.resolvedFfmpegPath = null;

    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    for (const buffered of this.terminalOutputBuffers.values()) {
      if (buffered.timer) {
        clearTimeout(buffered.timer);
      }
    }
    this.terminalOutputBuffers.clear();
    for (const terminal of terminals) {
      this.destroyTerminalSession(terminal);
    }

    const interactiveClient = this.interactiveClient;
    this.interactiveClient = null;
    const jumpClient = this.jumpClient;
    this.jumpClient = null;
    this.activeConnectConfig = null;
    this.activeConnectMetadata = null;
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
    this.activeTunnels.clear();
    this.remoteTunnelBindings.clear();
    this.tunnelStates.clear();
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

    if (jumpClient) {
      jumpClient.removeAllListeners();
      jumpClient.end();
    }

    this.emitConnectionState({
      state: 'disconnected',
      message: 'Disconnected',
      filesystemState: 'idle',
      reason: 'manual',
      recoverable: true,
      authUrl: undefined,
    });

    this.isClosing = false;
  }

  async readDir(remotePath: string): Promise<RemoteDirectoryEntry[]> {
    return this.withForegroundActivity(async () => {
      const cached = this.directoryCache.get(remotePath);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.entries;
      }

      const nextEntries = this.sftp
        ? await this.readDirWithSftp(remotePath, this.sftp)
        : await this.readDirWithShell(remotePath);

      this.directoryCache.set(remotePath, {
        entries: nextEntries,
        expiresAt: Date.now() + READDIR_CACHE_TTL_MS,
      });

      return nextEntries;
    });
  }

  startAutomaticMediaCache(remoteDirectory: string): void {
    this.requireSftp();
    this.idleTransfers.startAutomaticMediaCache(remoteDirectory);
  }

  queueIdleDownload(remotePath: string, localPath: string) {
    this.requireSftp();
    return this.idleTransfers.queueManualDownload(remotePath, localPath);
  }

  getIdleTransferSnapshot() {
    return this.idleTransfers.snapshot();
  }

  cancelIdleDownload(remotePath: string) {
    return this.idleTransfers.cancel(remotePath);
  }

  cancelIdleDownloadGroup(groupPath: string) {
    return this.idleTransfers.cancelGroup(groupPath);
  }

  startLanguageServer(input: StartLanguageServerInput): Promise<StartLanguageServerResult> {
    return this.languageServers.start(this.requireInteractiveClient(), input);
  }

  stopLanguageServer(sessionId: string): Promise<void> {
    return this.languageServers.stop(sessionId);
  }

  openLanguageDocument(input: LanguageServerDocumentInput): Promise<void> {
    return this.languageServers.openDocument(input);
  }

  changeLanguageDocument(input: LanguageServerDocumentChangeInput): Promise<void> {
    return this.languageServers.changeDocument(input);
  }

  saveLanguageDocument(input: LanguageServerDocumentReference): Promise<void> {
    return this.languageServers.saveDocument(input);
  }

  closeLanguageDocument(input: LanguageServerDocumentReference): Promise<void> {
    return this.languageServers.closeDocument(input);
  }

  requestLanguageFeature(input: LanguageServerFeatureInput): Promise<unknown> {
    return this.languageServers.requestFeature(input);
  }

  async readFile(remotePath: string): Promise<RemoteFilePayload> {
    const releaseForeground = this.idleTransfers.governor.beginForeground();
    try {
      if (!this.sftp) {
        const { stdout, stderr, exitCode } = await this.execRemoteCommand(`cat ${quoteForShell(remotePath)}`);
        if (exitCode !== 0) {
          throw new Error(stderr.trim() || `Unable to read ${remotePath}`);
        }

        return {
          path: remotePath,
          content: stdout,
        };
      }

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
    } finally {
      releaseForeground();
    }
  }

  async writeFileAtomic(input: SaveRemoteFileInput): Promise<SaveRemoteFileResult> {
    const releaseForeground = this.idleTransfers.governor.beginForeground();
    try {
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
      await this.unlinkIfExists(temporaryPath).catch(() => {
        // ponytail: temp-file cleanup is best-effort after the write already failed.
      });
      throw new Error(getErrorMessage(error, `Unable to save ${input.path}`));
    }
    } finally {
      releaseForeground();
    }
  }

  async createEntry(input: CreateRemoteEntryInput): Promise<RemoteDirectoryEntry> {
    const targetPath = path.posix.join(input.parentPath, input.name);

    if (input.kind === 'directory') {
      if (this.sftp) {
        await new Promise<void>((resolve, reject) => {
          this.sftp!.mkdir(targetPath, (error?: Error | null) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      } else {
        const command = [`dir=${quoteForShell(targetPath)}`, 'mkdir "$dir"'].join('\n');
        const { stderr, exitCode } = await this.execRemoteCommand(command);
        if (exitCode !== 0) {
          throw new Error(stderr.trim() || `Unable to create ${targetPath}`);
        }
      }

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

    this.invalidateDirectoryCache(path.posix.dirname(input.path));
    this.invalidateDirectoryCache(input.path);
    this.invalidateDirectoryCache(targetPath);

    if (!this.sftp) {
      return {
        name: input.nextName,
        path: targetPath,
        kind: await this.getRemoteEntryKindWithShell(targetPath),
      };
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

  async deleteEntry(input: DeleteRemoteEntryInput): Promise<void> {
    const operationId = input.operationId ?? randomUUID();
    const totalItems = await this.countRemoteItems(input.path, undefined, true);
    const progress = this.createFileOperationProgress(operationId, 'delete', input.path, input.path, totalItems);

    this.emitFileOperationState(progress, 'running', `Deleting ${input.path}`);
    try {
      await this.deleteRemotePath(input.path, progress);
      this.invalidateDirectoryCache(path.posix.dirname(input.path));
      this.invalidateDirectoryCache(input.path);
      this.emitFileOperationState(progress, 'completed', `Deleted ${input.path}`);
    } catch (error) {
      this.emitFileOperationState(progress, 'failed', `Delete failed for ${input.path}`, {
        error: getErrorMessage(error, `Unable to delete ${input.path}`),
        retryable: true,
      });
      throw error;
    }
  }

  async uploadLocalEntries(input: UploadLocalEntriesInput): Promise<FileOperationResult> {
    if (input.localPaths.length === 0) {
      return { status: 'completed', skippedItems: 0 };
    }

    const transfer = await this.getTransferSftpHandle();
    const sftp = transfer.sftp ?? undefined;
    const conflicts = await this.collectUploadConflicts(input.localPaths, input.remotePath, sftp);
    if (conflicts.length > 0 && (input.conflictStrategy ?? 'ask') === 'ask') {
      return { status: 'conflict', conflicts };
    }

    const progress = this.createFileOperationProgress(
      input.operationId,
      'upload',
      input.localPaths[0] ?? input.remotePath,
      input.remotePath,
      await this.countLocalItems(input.localPaths),
      await this.countLocalBytes(input.localPaths),
      sftp ? 'sftp' : 'shell',
    );
    this.registerOperationCancel(progress);

    this.emitFileOperationState(progress, 'running', `Uploading into ${input.remotePath}`);
    try {
      for (const localPath of input.localPaths) {
        const stats = await fs.stat(localPath);
        const targetPath = path.posix.join(input.remotePath, normalizeLocalName(localPath));
        if (stats.isDirectory()) {
          await this.uploadLocalDirectory(localPath, targetPath, sftp, progress, input.conflictStrategy ?? 'ask');
        } else if (stats.isFile()) {
          await this.uploadLocalFile(localPath, targetPath, sftp, progress, input.conflictStrategy ?? 'ask');
        }
      }

      this.invalidateDirectoryCache(input.remotePath);
      this.emitFileOperationState(progress, 'completed', `Uploaded into ${input.remotePath}`);
      return {
        status: 'completed',
        skippedItems: progress.skippedItems,
      };
    } catch (error) {
      if (error instanceof TransferCanceledError || progress.canceled) {
        this.emitFileOperationState(progress, 'canceled', `Upload canceled for ${input.remotePath}`, {
          error: 'Canceled. Partial data is kept so the transfer can resume.',
          retryable: true,
        });
        return {
          status: 'completed',
          skippedItems: progress.skippedItems,
        };
      }
      this.emitFileOperationState(progress, 'failed', `Upload failed for ${input.remotePath}`, {
        error: getErrorMessage(error, `Unable to upload into ${input.remotePath}`),
        retryable: true,
      });
      throw error;
    } finally {
      this.activeTransfers.delete(input.operationId);
    }
  }

  async downloadEntry(input: DownloadRemoteEntryInput): Promise<FileOperationResult> {
    const transfer = await this.getTransferSftpHandle();
    const conflicts = transfer.sftp
      ? await this.collectDownloadConflicts(input.remotePath, input.localPath, transfer.sftp)
      : await this.collectDownloadConflictsWithShell(input.remotePath, input.localPath);
    if (conflicts.length > 0 && (input.conflictStrategy ?? 'ask') === 'ask') {
      return { status: 'conflict', conflicts };
    }

    const progress = this.createFileOperationProgress(
      input.operationId,
      'download',
      input.remotePath,
      input.localPath,
      // Start immediately. Recursive enumeration of a large directory can take
      // minutes over SFTP, so totals are filled in asynchronously below.
      1,
      0,
      transfer.sftp ? 'sftp' : 'shell',
    );
    this.registerOperationCancel(progress);

    this.emitFileOperationState(progress, 'running', `Downloading ${input.remotePath}`);
    void (async () => {
      const [totalItems, totalBytes] = transfer.sftp
        ? await Promise.all([
            this.countRemoteItems(input.remotePath, transfer.sftp),
            this.countRemoteBytes(input.remotePath, transfer.sftp),
          ])
        : await Promise.all([
            this.countRemoteItemsWithShell(input.remotePath),
            this.countRemoteBytesWithShell(input.remotePath),
          ]);
      if (this.activeTransfers.has(input.operationId) && !progress.canceled) {
        progress.totalItems = Math.max(totalItems, 1);
        progress.totalBytes = totalBytes;
        this.emitFileOperationState(progress, 'running', `Downloading ${input.remotePath}`);
      }
    })().catch(() => undefined);
    try {
      if (transfer.sftp) {
        const stats = await this.statPath(input.remotePath, transfer.sftp);
        if (isDirectory(stats.mode)) {
          await this.downloadDirectory(
            input.remotePath,
            input.localPath,
            transfer.sftp,
            progress,
            input.conflictStrategy ?? 'ask',
          );
        } else {
          await this.downloadRemoteFile(
            input.remotePath,
            input.localPath,
            transfer.sftp,
            progress,
            input.conflictStrategy ?? 'ask',
          );
        }
      } else {
        const remoteKind = await this.getRemoteEntryKindWithShell(input.remotePath);
        if (remoteKind === 'directory') {
          await this.downloadDirectoryWithShell(
            input.remotePath,
            input.localPath,
            progress,
            input.conflictStrategy ?? 'ask',
          );
        } else {
          await this.downloadRemoteFileWithShell(
            input.remotePath,
            input.localPath,
            progress,
            input.conflictStrategy ?? 'ask',
          );
        }
      }
      this.emitFileOperationState(progress, 'completed', `Downloaded ${input.remotePath}`);
      return {
        status: 'completed',
        skippedItems: progress.skippedItems,
      };
    } catch (error) {
      if (error instanceof TransferCanceledError || progress.canceled) {
        this.emitFileOperationState(progress, 'canceled', `Download canceled for ${input.remotePath}`, {
          error: 'Canceled. Partial data is kept so the transfer can resume.',
          retryable: true,
        });
        return {
          status: 'completed',
          skippedItems: progress.skippedItems,
        };
      }
      this.emitFileOperationState(progress, 'failed', `Download failed for ${input.remotePath}`, {
        error: getErrorMessage(error, `Unable to download ${input.remotePath}`),
        retryable: true,
      });
      throw error;
    } finally {
      this.activeTransfers.delete(input.operationId);
    }
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

      if ((await this.getRemoteEntryKind(remotePath)) === 'directory') {
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

  /**
   * Detects whether the remote host can host persistent shell sessions, and
   * lists the ones that already exist. The multiplexer kind is probed once per
   * connection; the session list is always read live because sessions come and
   * go outside this app.
   */
  async getRemoteShellSupport(): Promise<RemoteShellSupport> {
    const kind = await this.resolvePersistentShellKind();
    const listCommand = buildListSessionsCommand(kind);
    if (!listCommand) {
      return { kind, sessions: [] };
    }

    const { stdout } = await this.execRemoteCommand(listCommand);
    return { kind, sessions: parseSessionList(kind, stdout) };
  }

  async killRemoteShellSession(sessionName: string): Promise<void> {
    const kind = await this.resolvePersistentShellKind();
    if (kind === 'none') {
      throw new Error('No persistent shell multiplexer is available on the remote host');
    }

    const { stderr, exitCode } = await this.execRemoteCommand(buildKillSessionCommand(kind, sessionName));
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Unable to end session ${sessionName}`);
    }
  }

  private async resolvePersistentShellKind(): Promise<PersistentShellKind> {
    if (this.persistentShellKind) {
      return this.persistentShellKind;
    }

    const { stdout } = await this.execRemoteCommand(buildSupportProbeCommand());
    const kind = parseSupportProbe(stdout);
    this.persistentShellKind = kind;
    return kind;
  }

  async createTerminal(input?: CreateTerminalInput): Promise<CreateTerminalResult> {
    if (!this.interactiveClient || !this.connectionId) {
      throw new Error('No active SSH connection');
    }

    const config = this.buildCurrentConnectConfigSnapshot();
    if (!config) {
      throw new Error('No active SSH connection');
    }

    // Resolved before the extra client is opened so a probe failure does not
    // leave an orphaned connection behind.
    const requestedSessionName = input?.sessionName?.trim() ?? '';
    const persistentKind =
      requestedSessionName === ''
        ? 'none'
        : await this.resolvePersistentShellKind().catch(() => 'none' as PersistentShellKind);

    const terminalId = randomUUID();
    const client = await this.createConnectedClient(config);

    if (!this.interactiveClient || !this.connectionId || this.isClosing) {
      client.removeAllListeners();
      client.end();
      throw new Error('No active SSH connection');
    }

    let terminal: ClientChannel;
    try {
      terminal =
        persistentKind === 'none'
          ? await this.createTerminalChannel(client)
          : await this.createTerminalChannel(
              client,
              buildAttachCommand({
                kind: persistentKind,
                sessionName: requestedSessionName,
                workspacePath: input?.workspacePath,
                // Passed through the attach command so a newly created session
                // inherits it without typing anything into a running job.
                env: this.visionModeDisplay ? { DISPLAY: this.visionModeDisplay } : undefined,
              }),
            );
    } catch (error) {
      this.closeTerminalClient(client);
      throw error;
    }

    const normalizedSessionName =
      persistentKind === 'none' ? undefined : normalizeSessionName(requestedSessionName);
    const session: TerminalSession = {
      client,
      channel: terminal,
      sessionName: normalizedSessionName,
      persistentKind: persistentKind === 'none' ? undefined : persistentKind,
    };

    if (!this.interactiveClient || !this.connectionId || this.isClosing) {
      this.destroyTerminalSession(session);
      throw new Error('No active SSH connection');
    }

    this.terminals.set(terminalId, session);

    terminal.on('data', (chunk: Buffer | string) => {
      if (this.terminals.get(terminalId) !== session) {
        return;
      }

      this.bufferTerminalOutput(terminalId, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    terminal.on('close', () => {
      if (this.terminals.get(terminalId) !== session) {
        return;
      }

      this.flushTerminalOutput(terminalId);
      this.terminals.delete(terminalId);
      this.closeTerminalClient(session.client);

      this.emitTerminalEvent({
        type: 'exit',
        terminalId,
      });
    });

    terminal.on('error', (error: Error) => {
      if (this.terminals.get(terminalId) !== session) {
        return;
      }

      this.flushTerminalOutput(terminalId);
      this.emitTerminalEvent({
        type: 'error',
        terminalId,
        message: getErrorMessage(error, 'Terminal session error'),
      });
    });

    client.on('close', () => {
      if (this.terminals.get(terminalId) !== session) {
        return;
      }

      this.flushTerminalOutput(terminalId);
      this.terminals.delete(terminalId);

      this.emitTerminalEvent({
        type: 'exit',
        terminalId,
      });
    });

    client.on('end', () => {
      if (this.terminals.get(terminalId) !== session) {
        return;
      }

      this.flushTerminalOutput(terminalId);
      this.terminals.delete(terminalId);

      this.emitTerminalEvent({
        type: 'exit',
        terminalId,
      });
    });

    client.on('error', (error: Error) => {
      if (this.terminals.get(terminalId) !== session) {
        return;
      }

      this.flushTerminalOutput(terminalId);
      this.emitTerminalEvent({
        type: 'error',
        terminalId,
        message: getErrorMessage(error, 'Terminal SSH connection error'),
      });
    });

    if (persistentKind === 'none') {
      if (this.visionModeDisplay) {
        await this.writeTerminal(terminalId, `export DISPLAY=${this.visionModeDisplay}\r`).catch(() => undefined);
      }

      return { terminalId };
    }

    // The normalized name is what actually reached tmux/screen, so the renderer
    // must report and re-attach with that rather than the raw request.
    return { terminalId, sessionName: normalizedSessionName, persistentKind };
  }

  async writeTerminal(terminalId: string, data: string): Promise<void> {
    this.idleTransfers.governor.noteForegroundActivity();
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

    this.destroyTerminalSession(terminal);
    this.emitTerminalEvent({
      type: 'exit',
      terminalId,
    });
  }

  /**
   * Starts (or retunes) periodic host telemetry polling. Only one poller runs
   * per session; calling this again just updates the interval and the
   * filesystem whose free space is reported.
   */
  async startHostMetrics(workspacePath: string, intervalMs?: number): Promise<void> {
    if (!this.interactiveClient || !this.connectionId) {
      throw new Error('No active SSH connection');
    }

    const normalizedInterval = Math.max(
      HOST_METRICS_MIN_INTERVAL_MS,
      Math.round(intervalMs ?? HOST_METRICS_DEFAULT_INTERVAL_MS),
    );

    if (this.hostMetricsPoller) {
      this.hostMetricsPoller.intervalMs = normalizedInterval;
      this.hostMetricsPoller.workspacePath = workspacePath;
      return;
    }

    const poller: HostMetricsPoller = {
      timer: null,
      intervalMs: normalizedInterval,
      workspacePath,
      inFlight: false,
      stopped: false,
    };
    this.hostMetricsPoller = poller;
    void this.runHostMetricsPoll(poller);
  }

  stopHostMetrics(): void {
    const poller = this.hostMetricsPoller;
    this.hostMetricsPoller = null;
    if (!poller) {
      return;
    }

    poller.stopped = true;
    if (poller.timer) {
      clearTimeout(poller.timer);
      poller.timer = null;
    }
  }

  async collectHostMetrics(workspacePath: string): Promise<HostMetricsSnapshot> {
    const { stdout } = await this.execRemoteCommand(buildMetricsCommand(workspacePath));
    return parseMetricsOutput(stdout);
  }

  /**
   * Polls once, emits the result, then schedules the next run from the
   * completion time rather than on a fixed interval. That keeps a slow or
   * stalled host from queueing up overlapping `exec` channels.
   */
  private async runHostMetricsPoll(poller: HostMetricsPoller): Promise<void> {
    if (poller.stopped || this.hostMetricsPoller !== poller) {
      return;
    }

    const connectionId = this.connectionId;
    if (!connectionId || !this.interactiveClient) {
      this.scheduleHostMetricsPoll(poller);
      return;
    }

    poller.inFlight = true;
    try {
      const snapshot = await this.collectHostMetrics(poller.workspacePath);
      if (!poller.stopped && this.hostMetricsPoller === poller && this.connectionId === connectionId) {
        this.emitHostMetricsEvent({ connectionId, snapshot });
      }
    } catch (error) {
      if (!poller.stopped && this.hostMetricsPoller === poller && this.connectionId === connectionId) {
        this.emitHostMetricsEvent({
          connectionId,
          error: getErrorMessage(error, 'Unable to collect host metrics'),
        });
      }
    } finally {
      poller.inFlight = false;
      this.scheduleHostMetricsPoll(poller);
    }
  }

  private scheduleHostMetricsPoll(poller: HostMetricsPoller): void {
    if (poller.stopped || this.hostMetricsPoller !== poller) {
      return;
    }

    poller.timer = setTimeout(() => {
      poller.timer = null;
      void this.runHostMetricsPoll(poller);
    }, poller.intervalMs);
  }

  private emitHostMetricsEvent(event: HostMetricsEvent): void {
    for (const listener of this.hostMetricsListeners) {
      listener(event);
    }
  }

  /**
   * Reads a remote file as raw bytes for preview purposes (result plots, sample
   * images), rather than the utf8 text path used by the editor. Size is checked
   * before transfer so a stray multi-gigabyte file cannot be pulled by accident.
   */
  async readBinaryFile(input: ReadRemoteBinaryFileInput): Promise<RemoteBinaryFilePayload> {
    const releaseForeground = this.idleTransfers.governor.beginForeground();
    try {
      const sftp = this.requireSftp();
      const maxBytes = Math.max(1, Math.round(input.maxBytes ?? BINARY_FILE_DEFAULT_MAX_BYTES));

      const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.stat(input.path, (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(result);
        });
      });

      const size = typeof stats.size === 'number' ? stats.size : 0;
      if (size > maxBytes) {
        throw new Error(
          `${input.path} is ${formatByteSize(size)}, larger than the ${formatByteSize(maxBytes)} preview limit. Download it instead.`,
        );
      }

      const modifiedAt = typeof stats.mtime === 'number' ? stats.mtime * 1000 : undefined;
      const cached = await this.idleTransfers.readCached(input.path, size, modifiedAt);
      if (cached) {
        return {
          path: input.path,
          base64: cached.toString('base64'),
          byteLength: cached.length,
          modifiedAt,
        };
      }

      const chunks: Buffer[] = [];
      let received = 0;

      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createReadStream(input.path);

        stream.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            stream.destroy();
            reject(new Error(`${input.path} exceeded the ${formatByteSize(maxBytes)} preview limit while reading`));
            return;
          }

          chunks.push(chunk);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve());
      });

      const data = Buffer.concat(chunks);
      return {
        path: input.path,
        base64: data.toString('base64'),
        byteLength: data.length,
        modifiedAt,
      };
    } finally {
      releaseForeground();
    }
  }

  /**
   * Ensures a virtual X display (Xvfb) is running on the remote host.
   * Idempotent: if a matching Xvfb process is already running, it is left alone.
   * This lets headless vision nodes (no physical monitor) have a real X server
   * to render into, which we can then capture with ffmpeg x11grab.
   */
  async ensureVirtualDisplay(display: string = VISION_DEFAULT_DISPLAY): Promise<EnsureVirtualDisplayResult> {
    const normalizedDisplay = display.trim() || VISION_DEFAULT_DISPLAY;
    const checkCommand = `pgrep -f ${quoteForShell(`Xvfb ${normalizedDisplay} `)} >/dev/null 2>&1 && echo RUNNING || echo NOTRUNNING`;
    const check = await this.execRemoteCommand(checkCommand);
    if (check.stdout.includes('RUNNING')) {
      return { display: normalizedDisplay, alreadyRunning: true };
    }

    const startCommand = [
      'command -v Xvfb >/dev/null 2>&1 || { echo "XVFB_MISSING" >&2; exit 127; }',
      `nohup Xvfb ${normalizedDisplay} -screen 0 1280x720x24 >/tmp/sshstudio-xvfb-${normalizedDisplay.replace(/[^\w]/g, '')}.log 2>&1 &`,
      'disown',
    ].join('\n');

    const started = await this.execRemoteCommand(startCommand);
    if (started.exitCode === 127 || started.stderr.includes('XVFB_MISSING')) {
      throw new Error('Xvfb is not installed on the remote host. Install it with: sudo apt install xvfb');
    }

    // Give Xvfb a brief moment to bind its socket before callers try to use the display.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const confirm = await this.execRemoteCommand(checkCommand);
    if (!confirm.stdout.includes('RUNNING')) {
      throw new Error(`Unable to start Xvfb on display ${normalizedDisplay}`);
    }

    return { display: normalizedDisplay, alreadyRunning: false };
  }

  /**
   * Enables "vision mode": ensures a virtual display exists, then injects
   * `export DISPLAY=...` into every currently open terminal so any command
   * run from now on (including re-running an already-written vision program)
   * will render into the virtual display instead of trying to reach a
   * physical/forwarded X server. Newly opened terminals automatically pick up
   * the same DISPLAY via createTerminal().
   */
  async enableVisionMode(display?: string): Promise<EnableVisionModeResult> {
    const { display: resolvedDisplay } = await this.ensureVirtualDisplay(display ?? VISION_DEFAULT_DISPLAY);
    this.visionModeDisplay = resolvedDisplay;

    const exportLine = `export DISPLAY=${resolvedDisplay}\r`;
    for (const [terminalId, session] of this.terminals) {
      // A persistent session may be running a training job rather than sitting
      // at a prompt, so typing an export would go into that program's stdin.
      // tmux `setenv` applies to panes started afterwards instead; screen has no
      // equivalent, so those sessions keep whatever DISPLAY they started with.
      if (session.sessionName && session.persistentKind) {
        const command = buildSetSessionEnvCommand(
          session.persistentKind,
          session.sessionName,
          'DISPLAY',
          resolvedDisplay,
        );
        if (command) {
          await this.execRemoteCommand(command).catch(() => undefined);
        }
        continue;
      }

      await this.writeTerminal(terminalId, exportLine).catch(() => undefined);
    }

    return { display: resolvedDisplay };
  }

  disableVisionMode(): void {
    this.visionModeDisplay = null;
  }

  /**
   * Finds an ffmpeg binary on the remote host that actually supports the
   * x11grab input device, and caches the result for the lifetime of this
   * session. This deliberately checks well-known distro install paths before
   * falling back to plain `ffmpeg` (PATH lookup), because a user's default
   * shell environment may have a conda/venv environment active whose ffmpeg
   * build lacks x11grab support (common with the conda-forge ffmpeg package).
   * Picking that one up silently would let the ffmpeg process exit immediately
   * with "Unknown input format: 'x11grab'", producing no frames (or garbled
   * partial output) with no obvious error surfaced to the user.
   */
  private async resolveFfmpegBinary(): Promise<string> {
    if (this.resolvedFfmpegPath) {
      return this.resolvedFfmpegPath;
    }

    const candidates = [...FFMPEG_CANDIDATE_PATHS, 'ffmpeg'];
    for (const candidate of candidates) {
      const probeCommand = `command -v ${quoteForShell(candidate)} >/dev/null 2>&1 && ${quoteForShell(
        candidate,
      )} -hide_banner -formats 2>&1 | grep -q x11grab && echo SUPPORTED || echo UNSUPPORTED`;
      const result = await this.execRemoteCommand(probeCommand).catch(() => null);
      if (result?.stdout.includes('SUPPORTED')) {
        this.resolvedFfmpegPath = candidate;
        return candidate;
      }
    }

    throw new Error(
      'No ffmpeg with x11grab support was found on the remote host (checked /usr/bin, /usr/local/bin, /bin, and PATH). ' +
        'If ffmpeg is only available inside a conda/venv environment, that build likely lacks x11grab support. ' +
        'Install a distro package (e.g. `sudo apt install ffmpeg`) to enable vision mode.',
    );
  }

  /**
   * Starts an ffmpeg x11grab capture of the given virtual display and streams
   * MJPEG frames back over the existing SSH connection (via a plain exec
   * channel, same pattern as execRemoteCommand). Frames are split on JPEG
   * SOI/EOI byte markers (FFD8...FFD9) as they arrive and emitted individually
   * so the renderer never has to do its own demuxing.
   */
  async startVideoStream(input: StartVideoStreamInput): Promise<StartVideoStreamResult> {
    const client = this.requireInteractiveClient();
    const streamId = randomUUID();
    const size = `${Math.max(1, Math.round(input.width))}x${Math.max(1, Math.round(input.height))}`;
    const fps = Math.max(1, Math.min(60, Math.round(input.fps)));
    const quality = Math.max(2, Math.min(31, Math.round(input.quality)));
    const ffmpegBinary = await this.resolveFfmpegBinary();

    const command = [
      `${quoteForShell(ffmpegBinary)} -loglevel error`,
      `-f x11grab -video_size ${size} -framerate ${fps} -i ${quoteForShell(input.display)}`,
      `-vf fps=${fps}`,
      `-f mjpeg -q:v ${quality} -threads 1`,
      'pipe:1',
    ].join(' ');

    return new Promise<StartVideoStreamResult>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }

        const session: ActiveVideoStreamSession = {
          channel,
          buffer: Buffer.alloc(0),
          seq: 0,
        };
        this.videoStreams.set(streamId, session);

        let stderrOutput = '';
        channel.stderr.on('data', (chunk: Buffer | string) => {
          stderrOutput += chunk.toString();
        });

        channel.on('data', (chunk: Buffer) => {
          if (this.videoStreams.get(streamId) !== session) {
            return;
          }

          session.buffer = Buffer.concat([session.buffer, chunk]);
          this.drainVideoFrames(streamId, session);
        });

        channel.on('close', (exitCode: number | null) => {
          if (this.videoStreams.get(streamId) !== session) {
            return;
          }

          this.videoStreams.delete(streamId);
          if (exitCode !== 0 && exitCode !== null) {
            this.emitVideoStreamStateEvent({
              streamId,
              status: 'error',
              message: stderrOutput.trim() || `ffmpeg exited with code ${exitCode}`,
            });
          } else {
            this.emitVideoStreamStateEvent({ streamId, status: 'stopped' });
          }
        });

        channel.on('error', (channelError: Error) => {
          if (this.videoStreams.get(streamId) !== session) {
            return;
          }

          this.videoStreams.delete(streamId);
          this.emitVideoStreamStateEvent({
            streamId,
            status: 'error',
            message: getErrorMessage(channelError, 'Video stream error'),
          });
        });

        this.emitVideoStreamStateEvent({ streamId, status: 'running' });
        resolve({ streamId });
      });
    });
  }

  private drainVideoFrames(streamId: string, session: ActiveVideoStreamSession): void {
    const SOI = Buffer.from([0xff, 0xd8]);
    const EOI = Buffer.from([0xff, 0xd9]);

    let start = session.buffer.indexOf(SOI);
    while (start !== -1) {
      const end = session.buffer.indexOf(EOI, start + SOI.length);
      if (end === -1) {
        // Incomplete frame: drop any garbage before the current SOI and wait for more data.
        if (start > 0) {
          session.buffer = session.buffer.subarray(start);
        }
        return;
      }

      const frameEnd = end + EOI.length;
      const frame = session.buffer.subarray(start, frameEnd);
      this.emitVideoFrameEvent({
        streamId,
        data: new Uint8Array(frame),
        seq: session.seq,
      });
      session.seq += 1;

      session.buffer = session.buffer.subarray(frameEnd);
      start = session.buffer.indexOf(SOI);
    }
  }

  async stopVideoStream(streamId: string): Promise<void> {
    const session = this.videoStreams.get(streamId);
    this.videoStreams.delete(streamId);
    if (!session) {
      return;
    }

    destroyChannel(session.channel);
    this.emitVideoStreamStateEvent({ streamId, status: 'stopped' });
  }

  listTunnelSnapshots(configs: SavedTunnelConfig[]): TunnelSnapshot[] {
    return configs.map((config) => ({
      config,
      state: this.getTunnelState(config.id),
    }));
  }

  async startTunnel(config: SavedTunnelConfig): Promise<void> {
    if (!this.interactiveClient || !this.connectionId || this.isClosing) {
      throw new Error('No active SSH connection');
    }

    if (this.activeTunnels.has(config.id)) {
      throw new Error(`Tunnel ${config.name} is already running`);
    }

    this.setTunnelState(config.id, 'starting', `Starting tunnel ${config.name}`);

    try {
      const session =
        config.kind === 'remote'
          ? await this.startRemoteTunnel(config)
          : await this.startLocalTunnel(config);

      this.activeTunnels.set(config.id, session);
      this.setTunnelState(config.id, 'running', this.getTunnelRunningMessage(config, session));
    } catch (error) {
      await this.cleanupTunnel(config.id);
      this.setTunnelState(config.id, 'error', getErrorMessage(error, `Unable to start tunnel ${config.name}`));
      throw error instanceof Error ? error : new Error('Unable to start tunnel');
    }
  }

  async stopTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.activeTunnels.get(tunnelId);
    await this.cleanupTunnel(tunnelId);
    this.setTunnelState(tunnelId, 'stopped', tunnel ? `Stopped tunnel ${tunnel.config.name}` : undefined);
  }

  /**
   * Opens an interactive channel. Without `command` this is a plain login shell.
   * With one, the command runs under a PTY instead, which is what a multiplexer
   * attach needs (tmux refuses to run without a terminal).
   */
  private async createTerminalChannel(client: SshClient, command?: string): Promise<ClientChannel> {
    const window = {
      term: 'xterm-256color',
      cols: 120,
      rows: 32,
    };

    return new Promise<ClientChannel>((resolve, reject) => {
      const handle = (error: Error | undefined, stream: ClientChannel) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stream);
      };

      if (command === undefined) {
        client.shell(window, handle);
        return;
      }

      client.exec(command, { pty: window }, handle);
    });
  }

  private destroyTerminalSession(terminal: TerminalSession): void {
    this.destroyTerminalChannel(terminal.channel);
    this.closeTerminalClient(terminal.client);
  }

  private closeTerminalClient(client: SshClient): void {
    client.removeAllListeners();
    client.on('error', () => undefined);
    client.end();
  }

  private destroyTerminalChannel(terminal: ClientChannel): void {
    destroyChannel(terminal);
  }

  private getTunnelState(tunnelId: string): TunnelRuntimeState {
    return this.tunnelStates.get(tunnelId) ?? {
      id: tunnelId,
      status: 'stopped',
    };
  }

  private setTunnelState(tunnelId: string, status: TunnelRuntimeState['status'], message?: string): void {
    const nextState: TunnelRuntimeState = message ? { id: tunnelId, status, message } : { id: tunnelId, status };
    this.tunnelStates.set(tunnelId, nextState);
    this.emitTunnelEvent({
      type: 'state',
      state: nextState,
    });
  }

  private async startLocalTunnel(
    config: SavedLocalTunnelConfig | SavedDynamicTunnelConfig,
  ): Promise<LocalTunnelSession> {
    const server = net.createServer();
    const session: LocalTunnelSession = {
      kind: config.kind,
      config,
      server,
      sockets: new Set(),
      channels: new Set(),
    };

    server.on('connection', (socket) => {
      if (config.kind === 'dynamic') {
        void this.handleDynamicTunnelSocket(session, socket);
        return;
      }

      void this.handleLocalTunnelSocket(session, socket);
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(config.localPort, config.localHost);
    });

    server.on('error', (error) => {
      void this.cleanupTunnel(config.id).finally(() => {
        this.setTunnelState(config.id, 'error', getErrorMessage(error, `Tunnel ${config.name} stopped unexpectedly`));
      });
    });

    return session;
  }

  private async startRemoteTunnel(config: SavedRemoteTunnelConfig): Promise<RemoteTunnelSession> {
    const client = this.requireInteractiveClient();
    await new Promise<void>((resolve, reject) => {
      client.forwardIn(config.remoteHost, config.remotePort, (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.remoteTunnelBindings.set(buildRemoteTunnelKey(config.remoteHost, config.remotePort), config.id);
    return {
      kind: 'remote',
      config,
      sockets: new Set(),
      channels: new Set(),
    };
  }

  private async handleLocalTunnelSocket(session: LocalTunnelSession, socket: NetSocket): Promise<void> {
    session.sockets.add(socket);
    socket.on('close', () => {
      session.sockets.delete(socket);
    });
    socket.on('error', () => {
      session.sockets.delete(socket);
    });

    try {
      const config = session.config;
      if (config.kind !== 'local') {
        destroySocket(socket);
        return;
      }

      const channel = await this.forwardToRemote(
        socket.remoteAddress ?? config.localHost,
        socket.remotePort ?? 0,
        config.targetHost,
        config.targetPort,
      );
      this.bridgeTunnelConnection(socket, channel, session.sockets, session.channels);
    } catch {
      destroySocket(socket);
    }
  }

  private async handleDynamicTunnelSocket(session: LocalTunnelSession, socket: NetSocket): Promise<void> {
    session.sockets.add(socket);
    socket.on('close', () => {
      session.sockets.delete(socket);
    });
    socket.on('error', () => {
      session.sockets.delete(socket);
    });

    try {
      const result = await this.negotiateSocks5(socket, session.config.localHost);
      const channel = await this.forwardToRemote(
        socket.remoteAddress ?? session.config.localHost,
        socket.remotePort ?? 0,
        result.targetHost,
        result.targetPort,
      );
      socket.write(result.successResponse);
      this.bridgeTunnelConnection(socket, channel, session.sockets, session.channels);
      if (result.remaining.length > 0) {
        channel.write(result.remaining);
      }
    } catch {
      destroySocket(socket);
    }
  }

  private async negotiateSocks5(
    socket: NetSocket,
    fallbackHost: string,
  ): Promise<{ targetHost: string; targetPort: number; remaining: Buffer; successResponse: Buffer }> {
    let buffer = Buffer.alloc(0);

    const readChunk = () =>
      new Promise<Buffer>((resolve, reject) => {
        const cleanup = () => {
          socket.removeListener('data', handleData);
          socket.removeListener('close', handleClose);
          socket.removeListener('end', handleClose);
          socket.removeListener('error', handleError);
        };
        const handleData = (chunk: Buffer) => {
          cleanup();
          resolve(chunk);
        };
        const handleClose = () => {
          cleanup();
          reject(new Error('SOCKS client disconnected'));
        };
        const handleError = (error: Error) => {
          cleanup();
          reject(error);
        };

        socket.once('data', handleData);
        socket.once('close', handleClose);
        socket.once('end', handleClose);
        socket.once('error', handleError);
      });

    const readAtLeast = async (size: number): Promise<void> => {
      while (buffer.length < size) {
        buffer = Buffer.concat([buffer, await readChunk()]);
      }
    };

    await readAtLeast(2);
    const version = buffer[0];
    const methodCount = buffer[1];
    if (version !== 0x05) {
      throw new Error('Unsupported SOCKS version');
    }

    await readAtLeast(2 + methodCount);
    const methods = [...buffer.subarray(2, 2 + methodCount)];
    buffer = buffer.subarray(2 + methodCount);
    if (!methods.includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xff]));
      throw new Error('SOCKS client requires unsupported authentication');
    }

    socket.write(Buffer.from([0x05, 0x00]));

    await readAtLeast(4);
    const requestVersion = buffer[0];
    const command = buffer[1];
    const addressType = buffer[3];
    if (requestVersion !== 0x05 || command !== 0x01) {
      socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      throw new Error('SOCKS command not supported');
    }

    let offset = 4;
    let targetHost = '';
    if (addressType === 0x01) {
      await readAtLeast(offset + 4 + 2);
      targetHost = [...buffer.subarray(offset, offset + 4)].join('.');
      offset += 4;
    } else if (addressType === 0x03) {
      await readAtLeast(offset + 1);
      const length = buffer[offset];
      offset += 1;
      await readAtLeast(offset + length + 2);
      targetHost = buffer.subarray(offset, offset + length).toString('utf8');
      offset += length;
    } else if (addressType === 0x04) {
      await readAtLeast(offset + 16 + 2);
      const parts: string[] = [];
      for (let index = 0; index < 16; index += 2) {
        parts.push(buffer.readUInt16BE(offset + index).toString(16));
      }
      targetHost = parts.join(':');
      offset += 16;
    } else {
      socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      throw new Error('SOCKS address type not supported');
    }

    const targetPort = buffer.readUInt16BE(offset);
    const remaining = buffer.subarray(offset + 2);
    const responseAddress = net.isIPv4(fallbackHost)
      ? fallbackHost.split('.').map((part) => Number(part))
      : [0, 0, 0, 0];

    return {
      targetHost,
      targetPort,
      remaining,
      successResponse: Buffer.from([0x05, 0x00, 0x00, 0x01, ...responseAddress, 0x00, 0x00]),
    };
  }

  private async forwardToRemote(
    srcHost: string,
    srcPort: number,
    targetHost: string,
    targetPort: number,
  ): Promise<ClientChannel> {
    const client = this.requireInteractiveClient();
    return new Promise<ClientChannel>((resolve, reject) => {
      client.forwardOut(srcHost, srcPort, targetHost, targetPort, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(channel);
      });
    });
  }

  private bridgeTunnelConnection(
    socket: NetSocket,
    channel: ClientChannel,
    sockets: Set<NetSocket>,
    channels: Set<ClientChannel>,
  ): void {
    sockets.add(socket);
    channels.add(channel);

    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }

      closed = true;
      sockets.delete(socket);
      channels.delete(channel);
      destroySocket(socket);
      destroyChannel(channel);
    };

    socket.on('error', cleanup);
    socket.on('close', cleanup);
    channel.on('error', cleanup);
    channel.on('close', cleanup);

    socket.pipe(channel);
    channel.pipe(socket);
  }

  private async cleanupTunnel(tunnelId: string): Promise<void> {
    const session = this.activeTunnels.get(tunnelId);
    this.activeTunnels.delete(tunnelId);
    if (!session) {
      return;
    }

    for (const socket of session.sockets) {
      destroySocket(socket);
    }
    for (const channel of session.channels) {
      destroyChannel(channel);
    }
    session.sockets.clear();
    session.channels.clear();

    if (session.kind === 'remote') {
      this.remoteTunnelBindings.delete(buildRemoteTunnelKey(session.config.remoteHost, session.config.remotePort));
      if (this.interactiveClient) {
        await new Promise<void>((resolve) => {
          this.interactiveClient?.unforwardIn(session.config.remoteHost, session.config.remotePort, () => resolve());
        });
      }
    } else {
      await new Promise<void>((resolve) => {
        try {
          session.server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  private async stopAllTunnels(): Promise<void> {
    const tunnelIds = [...this.activeTunnels.keys()];
    for (const tunnelId of tunnelIds) {
      await this.cleanupTunnel(tunnelId);
      this.setTunnelState(tunnelId, 'stopped');
    }
    this.remoteTunnelBindings.clear();
  }

  private getTunnelRunningMessage(config: SavedTunnelConfig, session: ActiveTunnelSession): string {
    if (config.kind === 'dynamic') {
      const address = session.kind === 'dynamic' ? session.server.address() : null;
      const port = typeof address === 'object' && address ? (address as AddressInfo).port : config.localPort;
      return `SOCKS tunnel ${config.name} listening on ${config.localHost}:${port}`;
    }

    if (config.kind === 'local') {
      const address = session.kind === 'local' ? session.server.address() : null;
      const port = typeof address === 'object' && address ? (address as AddressInfo).port : config.localPort;
      return `Tunnel ${config.name} listening on ${config.localHost}:${port}`;
    }

    return `Remote tunnel ${config.name} listening on ${config.remoteHost}:${config.remotePort}`;
  }

  private handleRemoteTunnelConnection(
    details: RemoteTunnelConnectionInfo,
    accept: RemoteTunnelAccept,
    reject?: RemoteTunnelReject,
  ): void {
    const directKey = buildRemoteTunnelKey(details.destIP, details.destPort);
    const matchedTunnelId =
      this.remoteTunnelBindings.get(directKey) ??
      (() => {
        const byPort = [...this.activeTunnels.values()].find(
          (session) => session.kind === 'remote' && session.config.remotePort === details.destPort,
        );
        return byPort?.config.id;
      })();

    if (!matchedTunnelId) {
      reject?.();
      return;
    }

    const session = this.activeTunnels.get(matchedTunnelId);
    if (!session || session.kind !== 'remote') {
      reject?.();
      return;
    }

    const socket = net.connect({
      host: session.config.targetHost,
      port: session.config.targetPort,
    });

    let accepted = false;
    socket.once('connect', () => {
      const channel = accept();
      accepted = true;
      this.bridgeTunnelConnection(socket, channel, session.sockets, session.channels);
    });
    socket.once('error', () => {
      if (!accepted) {
        reject?.();
      }
      destroySocket(socket);
    });
  }

  private emitConnectionState(payload: ConnectionStatePayload): void {
    this.state = payload;
    for (const listener of this.connectionListeners) {
      listener(payload);
    }
  }

  private emitTerminalEvent(payload: TerminalEvent): void {
    if (payload.type === 'data') {
      this.idleTransfers.governor.noteForegroundActivity();
    }
    for (const listener of this.terminalListeners) {
      listener(payload);
    }
  }

  private emitTunnelEvent(payload: TunnelEvent): void {
    for (const listener of this.tunnelListeners) {
      listener(payload);
    }
  }

  private emitFileOperationEvent(payload: FileOperationEvent): void {
    for (const listener of this.fileOperationListeners) {
      listener(payload);
    }
  }

  private emitVideoFrameEvent(payload: VideoFrameEvent): void {
    this.idleTransfers.governor.noteForegroundActivity();
    for (const listener of this.videoFrameListeners) {
      listener(payload);
    }
  }

  private emitVideoStreamStateEvent(payload: VideoStreamStateEvent): void {
    for (const listener of this.videoStreamStateListeners) {
      listener(payload);
    }
  }

  private createFileOperationProgress(
    operationId: string,
    kind: FileOperationEvent['kind'],
    sourcePath: string,
    targetPath: string,
    totalItems: number,
    totalBytes = 0,
    transport: FileOperationEvent['transport'] = 'sftp',
  ): FileOperationProgress {
    return {
      operationId,
      kind,
      sourcePath,
      targetPath,
      totalItems: Math.max(totalItems, 1),
      completedItems: 0,
      skippedItems: 0,
      totalBytes,
      transferredBytes: 0,
      transport,
      rate: new RateEstimator(),
      lastEmitAt: 0,
      canceled: false,
    };
  }

  private emitFileOperationState(
    progress: FileOperationProgress,
    status: FileOperationEvent['status'],
    message: string,
    extras?: Pick<FileOperationEvent, 'currentPath' | 'error' | 'retryable'>,
  ): void {
    if (status === 'running') {
      this.idleTransfers.governor.noteForegroundActivity();
    }
    const hasBytes = progress.totalBytes > 0;
    this.emitFileOperationEvent({
      operationId: progress.operationId,
      kind: progress.kind,
      status,
      sourcePath: progress.sourcePath,
      targetPath: progress.targetPath,
      message,
      completedItems: progress.completedItems,
      totalItems: progress.totalItems,
      skippedItems: progress.skippedItems,
      currentPath: extras?.currentPath,
      error: extras?.error,
      retryable: extras?.retryable,
      transport: progress.transport,
      transferredBytes: hasBytes ? progress.transferredBytes : undefined,
      totalBytes: hasBytes ? progress.totalBytes : undefined,
      bytesPerSecond: hasBytes ? progress.rate.bytesPerSecond() : undefined,
      etaSeconds: hasBytes ? progress.rate.etaSeconds(progress.transferredBytes, progress.totalBytes) : undefined,
    });
  }

  /**
   * Accumulates transferred bytes and emits a throttled `running` event. The
   * estimator is fed on every call so the rate/ETA stay current, but the IPC
   * message only goes out every TRANSFER_PROGRESS_THROTTLE_MS (or when forced,
   * e.g. the final byte of a file).
   */
  private emitByteProgress(
    progress: FileOperationProgress,
    addedBytes: number,
    currentPath: string,
    force = false,
  ): void {
    progress.transferredBytes += addedBytes;
    const now = Date.now();
    progress.rate.record(progress.transferredBytes, now);
    if (!force && now - progress.lastEmitAt < TRANSFER_PROGRESS_THROTTLE_MS) {
      return;
    }

    progress.lastEmitAt = now;
    this.emitFileOperationState(
      progress,
      'running',
      `${progress.kind === 'download' ? 'Downloading' : 'Transferring'} ${currentPath}`,
      { currentPath },
    );
  }

  private throwIfCanceled(progress: FileOperationProgress): void {
    if (progress.canceled) {
      throw new TransferCanceledError();
    }
  }

  private advanceFileOperation(
    progress: FileOperationProgress,
    currentPath: string,
    skipped = false,
    amount = 1,
  ): void {
    if (skipped) {
      progress.skippedItems += amount;
    } else {
      progress.completedItems += amount;
    }
    this.emitFileOperationState(
      progress,
      'running',
      `${progress.kind === 'delete' ? 'Deleting' : progress.kind === 'upload' ? 'Transferring' : 'Downloading'} ${currentPath}`,
      { currentPath },
    );
  }

  private requireInteractiveClient(): SshClient {
    if (!this.interactiveClient) {
      throw new Error('No active SSH connection');
    }

    return this.interactiveClient;
  }

  private async withForegroundActivity<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.idleTransfers.governor.beginForeground();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new Error('No active SFTP session');
    }

    return this.sftp;
  }

  private requireTerminal(terminalId: string): ClientChannel {
    const terminal = this.terminals.get(terminalId)?.channel;
    if (!terminal) {
      throw new Error('No active terminal session');
    }

    return terminal;
  }

  private async execRemoteCommand(command: string): Promise<RemoteCommandResult> {
    const client = this.requireInteractiveClient();
    this.idleTransfers.governor.noteForegroundActivity();

    return new Promise<RemoteCommandResult>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (chunk: Buffer | string) => {
          this.idleTransfers.governor.noteForegroundActivity();
          stdout += chunk.toString();
        });
        stream.stderr.on('data', (chunk: Buffer | string) => {
          this.idleTransfers.governor.noteForegroundActivity();
          stderr += chunk.toString();
        });
        stream.on('error', reject);
        stream.on('close', (exitCode: number | null) => {
          resolve({ stdout, stderr, exitCode });
        });
      });
    });
  }

  private async writeRemoteStreamWithShell(remotePath: string, input: NodeJS.ReadableStream): Promise<void> {
    const client = this.requireInteractiveClient();
    const command = `cat > ${quoteForShell(remotePath)}`;

    await new Promise<void>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        let settled = false;
        let stderr = '';
        let pipelineFinished = false;
        let streamClosed = false;
        let exitCode: number | null = null;

        const rejectOnce = (nextError: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          reject(nextError instanceof Error ? nextError : new Error(String(nextError)));
        };

        const resolveOnce = () => {
          if (settled || !pipelineFinished || !streamClosed) {
            return;
          }

          if (exitCode !== 0) {
            rejectOnce(new Error(stderr.trim() || `Unable to write ${remotePath}`));
            return;
          }

          settled = true;
          resolve();
        };

        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        stream.on('error', rejectOnce);
        stream.on('close', (code: number | null) => {
          streamClosed = true;
          exitCode = code;
          resolveOnce();
        });
        input.on('error', rejectOnce);

        void pipeline(input, stream)
          .then(() => {
            pipelineFinished = true;
            resolveOnce();
          })
          .catch(rejectOnce);
      });
    });
  }

  private async resolveHomeDirectoryWithShell(): Promise<string> {
    try {
      const { stdout, exitCode } = await this.execRemoteCommand('pwd -P');
      if (exitCode !== 0) {
        return '/';
      }

      return stdout.trim() || '/';
    } catch {
      return '/';
    }
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

    if (authMethod === 'tailscale') {
      config.readyTimeout = 120000;
      config.authHandler = (authsLeft, _partialSuccess, next) => {
        const remainingAuths = authsLeft ?? ['none'];
        if (remainingAuths.includes('none')) {
          next('none');
          return;
        }
        if (remainingAuths.includes('keyboard-interactive')) {
          next('keyboard-interactive');
          return;
        }
        next(remainingAuths[0] ?? 'none');
      };
      config.tryKeyboard = true;
      return config;
    }

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
    const targetSftp = sftp ?? this.sftp;

    if (!targetSftp) {
      await this.writeRemoteStreamWithShell(remotePath, Readable.from([content]));
      return;
    }

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
    const sftp = this.sftp;

    if (!sftp) {
      const command = [`from=${quoteForShell(fromPath)}`, `to=${quoteForShell(toPath)}`, 'mv "$from" "$to"'].join('\n');
      const { stderr, exitCode } = await this.execRemoteCommand(command);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `Unable to rename ${fromPath}`);
      }
      return;
    }

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
    const sftp = this.sftp;

    if (!sftp) {
      const command = [`target=${quoteForShell(remotePath)}`, 'rm -f "$target"'].join('\n');
      const { stderr, exitCode } = await this.execRemoteCommand(command);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `Unable to remove ${remotePath}`);
      }
      return;
    }

    const exists = await new Promise<boolean>((resolve) => {
      sftp.exists(remotePath, (exists) => {
        resolve(exists);
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

  private createRemoteReadStream(remotePath: string, sftp?: SFTPWrapper, start = 0) {
    const targetSftp = sftp ?? this.requireSftp();
    return targetSftp.createReadStream(remotePath, start > 0 ? { start } : undefined);
  }

  private createRemoteReadStreamWithShell(remotePath: string) {
    const client = this.requireInteractiveClient();
    const command = [`target=${quoteForShell(remotePath)}`, 'cat "$target"'].join('\n');
    const output = new PassThrough();

    void new Promise<void>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          output.destroy(error);
          return;
        }

        let stderr = '';
        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        stream.on('error', (streamError: Error) => {
          output.destroy(streamError);
          reject(streamError);
        });
        stream.on('close', (exitCode: number | null) => {
          if (exitCode !== 0) {
            const nextError = new Error(stderr.trim() || `Unable to read ${remotePath}`);
            output.destroy(nextError);
            reject(nextError);
            return;
          }
          resolve();
        });
        stream.pipe(output);
      });
    }).catch((error) => {
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return output;
  }

  private createRemoteWriteStream(remotePath: string, sftp?: SFTPWrapper, start = 0) {
    const targetSftp = sftp ?? this.requireSftp();
    // Resuming: open with r+ and seek to `start` so existing bytes are kept.
    // Fresh: w truncates. ssh2's WriteStream honours both `flags` and `start`.
    return targetSftp.createWriteStream(
      remotePath,
      start > 0 ? { mode: 0o644, flags: 'r+', start } : { mode: 0o644, flags: 'w' },
    );
  }

  private async ensureRemoteDirectory(remotePath: string, sftp?: SFTPWrapper): Promise<void> {
    const targetSftp = sftp ?? this.sftp;
    if (!targetSftp) {
      const normalized = path.posix.normalize(remotePath);
      const command = [
        `dir=${quoteForShell(normalized)}`,
        'if [ -e "$dir" ] && [ ! -d "$dir" ]; then',
        'printf "%s exists and is not a directory\\n" "$dir" >&2',
        'exit 1',
        'fi',
        'mkdir -p -- "$dir"',
      ].join('\n');
      const { stderr, exitCode } = await this.execRemoteCommand(command);
      if (exitCode !== 0) {
        throw new Error(stderr.trim() || `Unable to create directory ${normalized}`);
      }
      return;
    }

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

  private async uploadLocalFile(
    localPath: string,
    remotePath: string,
    sftp?: SFTPWrapper,
    progress?: FileOperationProgress,
    conflictStrategy: FileConflictStrategy = 'ask',
  ): Promise<void> {
    const targetSftp = sftp ?? this.sftp;
    if (await this.remotePathExists(remotePath, targetSftp ?? undefined)) {
      if ((await this.getRemoteEntryKind(remotePath, targetSftp ?? undefined)) === 'directory') {
        if (conflictStrategy === 'skip') {
          if (progress) {
            this.advanceFileOperation(progress, remotePath, true);
          }
          return;
        }
        await this.deleteRemotePath(remotePath);
      } else if (conflictStrategy === 'skip') {
        if (progress) {
          this.advanceFileOperation(progress, remotePath, true);
        }
        return;
      }
    }
    await this.ensureRemoteDirectory(path.posix.dirname(remotePath), targetSftp ?? undefined);

    if (progress) {
      this.throwIfCanceled(progress);
    }

    if (targetSftp) {
      await this.uploadFileResumable(localPath, remotePath, targetSftp, progress);
    } else {
      // No SFTP handle (Tailscale/shell fallback): non-resumable cat write, but
      // still report bytes as they stream so the progress bar moves.
      const source = createReadStream(localPath);
      const counter = createByteCounter((bytes) => {
        if (progress) {
          this.emitByteProgress(progress, bytes, remotePath, false);
        }
      });
      await this.writeRemoteStreamWithShell(remotePath, source.pipe(counter));
      if (progress) {
        this.emitByteProgress(progress, 0, remotePath, true);
      }
    }

    if (progress) {
      this.advanceFileOperation(progress, remotePath);
    }
  }

  /**
   * Uploads a single file into a sibling `.part` and renames it into place only
   * once complete. If a `.part` from an earlier attempt exists and is shorter
   * than the source, the transfer resumes from its end instead of restarting.
   */
  private async uploadFileResumable(
    localPath: string,
    remotePath: string,
    sftp: SFTPWrapper,
    progress?: FileOperationProgress,
  ): Promise<void> {
    const localStats = await fs.stat(localPath);
    const sourceSize = localStats.size;
    const partPath = toPartPath(remotePath);

    let existingPartSize: number | undefined;
    try {
      existingPartSize = (await this.statPath(partPath, sftp)).size;
    } catch {
      existingPartSize = undefined;
    }

    const offset = resolveResumeOffset(existingPartSize, sourceSize);
    if (progress && offset > 0) {
      // Bytes already on the far side count as transferred so the bar and ETA
      // reflect real remaining work rather than restarting at zero.
      this.emitByteProgress(progress, offset, remotePath, true);
    }

    if (sourceSize === 0) {
      // Nothing to stream; just materialise an empty file at the part path.
      await new Promise<void>((resolve, reject) => {
        const stream = this.createRemoteWriteStream(partPath, sftp, 0);
        stream.on('error', reject);
        stream.on('close', () => resolve());
        stream.end();
      });
    } else {
      const source = createReadStream(localPath, offset > 0 ? { start: offset } : undefined);
      const counter = createByteCounter((bytes) => {
        if (progress) {
          this.emitByteProgress(progress, bytes, remotePath, false);
        }
      });
      const sink = this.createRemoteWriteStream(partPath, sftp, offset);

      const cancelDeferred = this.registerTransferStreams(progress, [source, counter, sink]);
      try {
        await pipeline(source, counter, sink);
      } finally {
        cancelDeferred();
      }
    }

    if (progress) {
      this.throwIfCanceled(progress);
      this.emitByteProgress(progress, 0, remotePath, true);
    }

    // Replace any existing destination, then atomically swap the part into place.
    await this.renameRemoteInto(partPath, remotePath, sftp);
  }

  private async renameRemoteInto(fromPath: string, toPath: string, sftp: SFTPWrapper): Promise<void> {
    if (await this.remotePathExists(toPath, sftp)) {
      await this.deleteRemotePath(toPath);
    }
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

  /**
   * Registers an operation so `cancelFileOperation` can flag it even before (or
   * between) individual file streams open. While a file is streaming,
   * `registerTransferStreams` upgrades the entry to also tear those streams down.
   */
  private registerOperationCancel(progress: FileOperationProgress): void {
    this.activeTransfers.set(progress.operationId, {
      cancel: () => {
        progress.canceled = true;
      },
    });
  }

  /**
   * Wires the live streams of an in-flight transfer into the cancel registry so
   * `cancelFileOperation` can destroy them mid-file. Returns a cleanup thunk that
   * restores the operation-level canceler once this file settles.
   */
  private registerTransferStreams(
    progress: FileOperationProgress | undefined,
    streams: Array<{ destroy(error?: Error): void }>,
  ): () => void {
    if (!progress) {
      return () => {};
    }

    const operationId = progress.operationId;
    this.activeTransfers.set(operationId, {
      cancel: () => {
        progress.canceled = true;
        for (const stream of streams) {
          try {
            stream.destroy(new TransferCanceledError());
          } catch {
            // best effort teardown
          }
        }
      },
    });

    return () => {
      // Only downgrade if we're still the active entry for this operation.
      if (this.activeTransfers.has(operationId)) {
        this.registerOperationCancel(progress);
      }
    };
  }

  /**
   * Cancels an in-flight upload/download. The live streams are destroyed and the
   * operation flagged; any `.part` file is left in place so the next attempt
   * resumes from where this one stopped. Unknown ids are ignored.
   */
  cancelFileOperation(operationId: string): void {
    this.activeTransfers.get(operationId)?.cancel();
  }

  /**
   * Reports whether the connected remote host has a usable `rsync`, caching the
   * result for the life of the connection. Used by the transfer-capabilities
   * probe that gates the Phase 2 rsync delta fast-path.
   */
  async probeRemoteRsync(): Promise<boolean> {
    if (this.remoteRsyncAvailable !== null) {
      return this.remoteRsyncAvailable;
    }
    try {
      const { exitCode } = await this.execRemoteCommand('command -v rsync >/dev/null 2>&1');
      this.remoteRsyncAvailable = exitCode === 0;
    } catch {
      this.remoteRsyncAvailable = false;
    }
    return this.remoteRsyncAvailable;
  }

  private async uploadLocalDirectory(
    localPath: string,
    remotePath: string,
    sftp?: SFTPWrapper,
    progress?: FileOperationProgress,
    conflictStrategy: FileConflictStrategy = 'ask',
  ): Promise<void> {
    const targetSftp = sftp ?? this.sftp;
    if (await this.remotePathExists(remotePath, targetSftp ?? undefined)) {
      if ((await this.getRemoteEntryKind(remotePath, targetSftp ?? undefined)) !== 'directory') {
        if (conflictStrategy === 'skip') {
          const summary = await this.summarizeLocalPath(localPath);
          if (progress) {
            this.advanceFileOperation(progress, remotePath, true, summary.files);
          }
          return;
        }
        await this.deleteRemotePath(remotePath);
      } else if (conflictStrategy === 'skip') {
        const summary = await this.summarizeLocalPath(localPath);
        if (progress) {
          this.advanceFileOperation(progress, remotePath, true, summary.files);
        }
        return;
      }
    }
    await this.ensureRemoteDirectory(remotePath, targetSftp ?? undefined);
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      const nextLocalPath = path.join(localPath, entry.name);
      const nextRemotePath = path.posix.join(remotePath, entry.name);
      if (entry.isDirectory()) {
        await this.uploadLocalDirectory(nextLocalPath, nextRemotePath, targetSftp ?? undefined, progress, conflictStrategy);
      } else if (entry.isFile()) {
        await this.uploadLocalFile(nextLocalPath, nextRemotePath, targetSftp ?? undefined, progress, conflictStrategy);
      }
    }
  }

  private async downloadRemoteFile(
    remotePath: string,
    localPath: string,
    sftp?: SFTPWrapper,
    progress?: FileOperationProgress,
    conflictStrategy: FileConflictStrategy = 'ask',
  ): Promise<void> {
    if (await this.localPathExists(localPath)) {
      const localStats = await fsLstat(localPath);
      if (localStats.isDirectory()) {
        if (conflictStrategy === 'skip') {
          if (progress) {
            this.advanceFileOperation(progress, localPath, true);
          }
          return;
        }
        await fs.rm(localPath, { recursive: true, force: true });
      } else if (conflictStrategy === 'skip') {
        if (progress) {
          this.advanceFileOperation(progress, localPath, true);
        }
        return;
      }
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });

    if (progress) {
      this.throwIfCanceled(progress);
    }

    const remoteStats = await this.statPath(remotePath, sftp);
    const sourceSize = typeof remoteStats.size === 'number' ? remoteStats.size : 0;
    const partPath = toPartPath(localPath);

    let existingPartSize: number | undefined;
    try {
      existingPartSize = (await fsLstat(partPath)).size;
    } catch {
      existingPartSize = undefined;
    }

    const offset = resolveResumeOffset(existingPartSize, sourceSize);
    if (progress && offset > 0) {
      this.emitByteProgress(progress, offset, localPath, true);
    }

    if (sourceSize === 0) {
      // Materialise an empty local file without opening a remote read stream.
      await fs.writeFile(partPath, '');
    } else {
      const source = this.createRemoteReadStream(remotePath, sftp, offset);
      const counter = createByteCounter((bytes) => {
        if (progress) {
          this.emitByteProgress(progress, bytes, localPath, false);
        }
      });
      // 'a' appends onto whatever the earlier attempt already fetched; 'w' starts clean.
      const sink = createWriteStream(partPath, offset > 0 ? { flags: 'a' } : { flags: 'w' });

      const cancelDeferred = this.registerTransferStreams(progress, [source, counter, sink]);
      try {
        await pipeline(source, counter, sink);
      } finally {
        cancelDeferred();
      }
    }

    if (progress) {
      this.throwIfCanceled(progress);
      this.emitByteProgress(progress, 0, localPath, true);
    }

    // Swap the completed part into place, replacing any prior destination file.
    await fs.rm(localPath, { force: true });
    await fs.rename(partPath, localPath);

    if (progress) {
      this.advanceFileOperation(progress, localPath);
    }
  }

  private async downloadRemoteFileWithShell(
    remotePath: string,
    localPath: string,
    progress?: FileOperationProgress,
    conflictStrategy: FileConflictStrategy = 'ask',
  ): Promise<void> {
    if (await this.localPathExists(localPath)) {
      const localStats = await fsLstat(localPath);
      if (localStats.isDirectory()) {
        if (conflictStrategy === 'skip') {
          if (progress) {
            this.advanceFileOperation(progress, localPath, true);
          }
          return;
        }
        await fs.rm(localPath, { recursive: true, force: true });
      } else if (conflictStrategy === 'skip') {
        if (progress) {
          this.advanceFileOperation(progress, localPath, true);
        }
        return;
      }
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const source = this.createRemoteReadStreamWithShell(remotePath);
    const counter = createByteCounter((bytes) => {
      if (progress) {
        this.emitByteProgress(progress, bytes, localPath, false);
      }
    });
    await pipeline(source, counter, createWriteStream(localPath));
    if (progress) {
      this.emitByteProgress(progress, 0, localPath, true);
      this.advanceFileOperation(progress, localPath);
    }
  }

  private async downloadDirectory(
    remotePath: string,
    localPath: string,
    sftp?: SFTPWrapper,
    progress?: FileOperationProgress,
    conflictStrategy: FileConflictStrategy = 'ask',
  ): Promise<void> {
    const targetSftp = sftp ?? this.requireSftp();
    if (await this.localPathExists(localPath)) {
      const localStats = await fsLstat(localPath);
      if (!localStats.isDirectory()) {
        if (conflictStrategy === 'skip') {
          const skipped = await this.countRemoteItems(remotePath, targetSftp);
          if (progress) {
            this.advanceFileOperation(progress, localPath, true, skipped);
          }
          return;
        }
        await fs.rm(localPath, { recursive: true, force: true });
      }
    }
    await fs.mkdir(localPath, { recursive: true });
    const entries = await this.readDirWithSftp(remotePath, targetSftp);
    for (const entry of entries) {
      const nextLocalPath = path.join(localPath, entry.name);
      if (entry.kind === 'directory') {
        await this.downloadDirectory(entry.path, nextLocalPath, targetSftp, progress, conflictStrategy);
      } else {
        await this.downloadRemoteFile(entry.path, nextLocalPath, targetSftp, progress, conflictStrategy);
      }
    }
  }

  private async downloadDirectoryWithShell(
    remotePath: string,
    localPath: string,
    progress?: FileOperationProgress,
    conflictStrategy: FileConflictStrategy = 'ask',
  ): Promise<void> {
    if (await this.localPathExists(localPath)) {
      const localStats = await fsLstat(localPath);
      if (!localStats.isDirectory()) {
        if (conflictStrategy === 'skip') {
          const skipped = await this.countRemoteItemsWithShell(remotePath);
          if (progress) {
            this.advanceFileOperation(progress, localPath, true, skipped);
          }
          return;
        }
        await fs.rm(localPath, { recursive: true, force: true });
      }
    }

    await fs.mkdir(localPath, { recursive: true });
    const entries = await this.readDirWithShell(remotePath);
    for (const entry of entries) {
      const nextLocalPath = path.join(localPath, entry.name);
      if (entry.kind === 'directory') {
        await this.downloadDirectoryWithShell(entry.path, nextLocalPath, progress, conflictStrategy);
      } else {
        await this.downloadRemoteFileWithShell(entry.path, nextLocalPath, progress, conflictStrategy);
      }
    }
  }

  private async readDirWithSftp(
    remotePath: string,
    sftp: SFTPWrapper,
    includePartialFiles = false,
  ): Promise<RemoteDirectoryEntry[]> {
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
      .filter(
        (entry: FileEntryWithStats) =>
          entry.filename !== '.' &&
          entry.filename !== '..' &&
          (includePartialFiles || !entry.filename.endsWith(PART_SUFFIX)),
      )
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

  private async readDirWithShell(remotePath: string, includePartialFiles = false): Promise<RemoteDirectoryEntry[]> {
    const command = [
      `dir=${quoteForShell(remotePath)}`,
      'cd "$dir" || exit 1',
      'for entry in ./* ./.[!.]* ./..?*; do',
      '[ -e "$entry" ] || continue',
      'name=${entry#./}',
      'if [ -d "$entry" ]; then kind=directory; else kind=file; fi',
      'printf "%s\\t%s\\n" "$kind" "$name"',
      'done',
    ].join('\n');
    const { stdout, stderr, exitCode } = await this.execRemoteCommand(command);

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Unable to read ${remotePath}`);
    }

    return stdout
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line): RemoteDirectoryEntry | null => {
        const separatorIndex = line.indexOf('\t');
        if (separatorIndex < 0) {
          return null;
        }

        const kind = line.slice(0, separatorIndex) === 'directory' ? 'directory' : 'file';
        const name = line.slice(separatorIndex + 1);
        if (name === '' || name === '.' || name === '..' || (!includePartialFiles && name.endsWith(PART_SUFFIX))) {
          return null;
        }

        return {
          name,
          path: path.posix.join(remotePath, name),
          kind,
        };
      })
      .filter((entry): entry is RemoteDirectoryEntry => entry !== null)
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'directory' ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
  }

  private async deleteRemotePath(remotePath: string, progress?: FileOperationProgress): Promise<void> {
    if ((await this.getRemoteEntryKind(remotePath)) === 'directory') {
      // The explorer intentionally hides resumable-transfer `.part` files, but
      // they still make a directory non-empty. Deletion must enumerate them.
      const entries = this.sftp
        ? await this.readDirWithSftp(remotePath, this.sftp, true)
        : await this.readDirWithShell(remotePath, true);
      for (const entry of entries) {
        await this.deleteRemotePath(entry.path, progress);
      }

      if (this.sftp) {
        await new Promise<void>((resolve, reject) => {
          this.sftp!.rmdir(remotePath, (error?: Error | null) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      } else {
        const command = [`target=${quoteForShell(remotePath)}`, 'rmdir "$target"'].join('\n');
        const { stderr, exitCode } = await this.execRemoteCommand(command);
        if (exitCode !== 0) {
          throw new Error(stderr.trim() || `Unable to remove ${remotePath}`);
        }
      }
      if (progress) {
        this.advanceFileOperation(progress, remotePath);
      }
      return;
    }

    await this.unlinkIfExists(remotePath);
    if (progress) {
      this.advanceFileOperation(progress, remotePath);
    }
  }

  private async countLocalItems(localPaths: string[]): Promise<number> {
    let total = 0;
    for (const localPath of localPaths) {
      total += await this.countLocalPath(localPath);
    }
    return total;
  }

  private async summarizeLocalPath(localPath: string): Promise<LocalPathSummary> {
    const stats = await fs.stat(localPath);
    if (stats.isFile()) {
      return { files: 1, directories: 0, bytes: stats.size };
    }
    if (!stats.isDirectory()) {
      return { files: 0, directories: 0, bytes: 0 };
    }
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    let files = 0;
    let directories = 1;
    let bytes = 0;
    for (const entry of entries) {
      const summary = await this.summarizeLocalPath(path.join(localPath, entry.name));
      files += summary.files;
      directories += summary.directories;
      bytes += summary.bytes;
    }
    return { files, directories, bytes };
  }

  /** Total byte size of everything under the given local paths (files only). */
  private async countLocalBytes(localPaths: string[]): Promise<number> {
    let total = 0;
    for (const localPath of localPaths) {
      total += (await this.summarizeLocalPath(localPath)).bytes;
    }
    return total;
  }

  /** Total byte size of a remote file or directory tree, via SFTP or shell. */
  private async countRemoteBytes(remotePath: string, sftp?: SFTPWrapper): Promise<number> {
    const targetSftp = sftp ?? this.sftp;
    const stats = await this.statPath(remotePath, targetSftp ?? undefined);
    if (!isDirectory(stats.mode)) {
      return typeof stats.size === 'number' ? stats.size : 0;
    }
    const entries = targetSftp
      ? await this.readDirWithSftp(remotePath, targetSftp)
      : await this.readDirWithShell(remotePath);
    let total = 0;
    for (const entry of entries) {
      total += await this.countRemoteBytes(entry.path, targetSftp ?? undefined);
    }
    return total;
  }

  private async countRemoteBytesWithShell(remotePath: string): Promise<number> {
    const entryKind = await this.getRemoteEntryKindWithShell(remotePath);
    if (entryKind === 'file') {
      const command = `wc -c < ${quoteForShell(remotePath)}`;
      const { stdout, exitCode } = await this.execRemoteCommand(command);
      if (exitCode !== 0) {
        return 0;
      }
      const parsed = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const entries = await this.readDirWithShell(remotePath);
    let total = 0;
    for (const entry of entries) {
      total += await this.countRemoteBytesWithShell(entry.path);
    }
    return total;
  }

  private async countLocalPath(localPath: string): Promise<number> {
    const stats = await fs.stat(localPath);
    if (stats.isFile()) {
      return 1;
    }
    if (!stats.isDirectory()) {
      return 0;
    }
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await this.countLocalPath(path.join(localPath, entry.name));
    }
    return total;
  }

  private async countRemoteItems(
    remotePath: string,
    sftp?: SFTPWrapper,
    includeDirectories = false,
  ): Promise<number> {
    const targetSftp = sftp ?? this.sftp;
    if ((await this.getRemoteEntryKind(remotePath, targetSftp ?? undefined)) === 'file') {
      return 1;
    }
    const entries = targetSftp
      ? await this.readDirWithSftp(remotePath, targetSftp)
      : await this.readDirWithShell(remotePath);
    let total = includeDirectories ? 1 : 0;
    for (const entry of entries) {
      total += await this.countRemoteItems(entry.path, targetSftp ?? undefined, includeDirectories);
    }
    return total;
  }

  private async countRemoteItemsWithShell(remotePath: string, includeDirectories = false): Promise<number> {
    const entryKind = await this.getRemoteEntryKindWithShell(remotePath);
    if (entryKind === 'file') {
      return 1;
    }

    const entries = await this.readDirWithShell(remotePath);
    let total = includeDirectories ? 1 : 0;
    for (const entry of entries) {
      total += await this.countRemoteItemsWithShell(entry.path, includeDirectories);
    }
    return total;
  }

  private async localPathExists(localPath: string): Promise<boolean> {
    try {
      await fsLstat(localPath);
      return true;
    } catch {
      return false;
    }
  }

  private async remotePathExists(remotePath: string, sftp?: SFTPWrapper): Promise<boolean> {
    const targetSftp = sftp ?? this.sftp;
    if (!targetSftp) {
      const { exitCode } = await this.execRemoteCommand(`[ -e ${quoteForShell(remotePath)} ]`);
      return exitCode === 0;
    }

    try {
      await this.statPath(remotePath, targetSftp);
      return true;
    } catch {
      return false;
    }
  }

  private async getRemoteEntryKind(remotePath: string, sftp?: SFTPWrapper): Promise<'file' | 'directory'> {
    const targetSftp = sftp ?? this.sftp;
    if (!targetSftp) {
      return this.getRemoteEntryKindWithShell(remotePath);
    }

    const stats = await this.statPath(remotePath, targetSftp);
    return isDirectory(stats.mode) ? 'directory' : 'file';
  }

  private async getRemoteEntryKindWithShell(remotePath: string): Promise<'file' | 'directory'> {
    const command = `[ -d ${quoteForShell(remotePath)} ] && printf directory || printf file`;
    const { stdout, stderr, exitCode } = await this.execRemoteCommand(command);
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Unable to inspect ${remotePath}`);
    }
    return stdout.trim() === 'directory' ? 'directory' : 'file';
  }

  private async collectUploadConflicts(
    localPaths: string[],
    remotePath: string,
    sftp?: SFTPWrapper,
  ): Promise<FileConflictItem[]> {
    const conflicts: FileConflictItem[] = [];
    for (const localPath of localPaths) {
      const targetPath = path.posix.join(remotePath, normalizeLocalName(localPath));
      await this.collectUploadConflictsForPath(localPath, targetPath, conflicts, sftp);
    }
    return conflicts;
  }

  private async collectUploadConflictsForPath(
    localPath: string,
    remotePath: string,
    conflicts: FileConflictItem[],
    sftp?: SFTPWrapper,
  ): Promise<void> {
    const targetSftp = sftp ?? this.sftp;
    const stats = await fs.stat(localPath);
    const remoteExists = await this.remotePathExists(remotePath, targetSftp ?? undefined);
    if (stats.isFile()) {
      if (remoteExists) {
        conflicts.push({ path: remotePath, kind: 'file' });
      }
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    if (remoteExists) {
      if ((await this.getRemoteEntryKind(remotePath, targetSftp ?? undefined)) !== 'directory') {
        conflicts.push({ path: remotePath, kind: 'file' });
        return;
      }
    }
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      await this.collectUploadConflictsForPath(
        path.join(localPath, entry.name),
        path.posix.join(remotePath, entry.name),
        conflicts,
        targetSftp ?? undefined,
      );
    }
  }

  private async collectDownloadConflicts(
    remotePath: string,
    localPath: string,
    sftp: SFTPWrapper,
  ): Promise<FileConflictItem[]> {
    const conflicts: FileConflictItem[] = [];
    await this.collectDownloadConflictsForPath(remotePath, localPath, conflicts, sftp);
    return conflicts;
  }

  private async collectDownloadConflictsForPath(
    remotePath: string,
    localPath: string,
    conflicts: FileConflictItem[],
    sftp: SFTPWrapper,
  ): Promise<void> {
    const stats = await this.statPath(remotePath, sftp);
    if (!isDirectory(stats.mode)) {
      if (await this.localPathExists(localPath)) {
        conflicts.push({ path: localPath, kind: 'file' });
      }
      return;
    }

    if (await this.localPathExists(localPath)) {
      const localStats = await fsLstat(localPath);
      if (!localStats.isDirectory()) {
        conflicts.push({ path: localPath, kind: 'file' });
        return;
      }
    }

    const entries = await this.readDirWithSftp(remotePath, sftp);
    for (const entry of entries) {
      await this.collectDownloadConflictsForPath(entry.path, path.join(localPath, entry.name), conflicts, sftp);
    }
  }

  private async collectDownloadConflictsWithShell(
    remotePath: string,
    localPath: string,
  ): Promise<FileConflictItem[]> {
    const conflicts: FileConflictItem[] = [];
    await this.collectDownloadConflictsForPathWithShell(remotePath, localPath, conflicts);
    return conflicts;
  }

  private async collectDownloadConflictsForPathWithShell(
    remotePath: string,
    localPath: string,
    conflicts: FileConflictItem[],
  ): Promise<void> {
    const entryKind = await this.getRemoteEntryKindWithShell(remotePath);
    if (entryKind === 'file') {
      if (await this.localPathExists(localPath)) {
        conflicts.push({ path: localPath, kind: 'file' });
      }
      return;
    }

    if (await this.localPathExists(localPath)) {
      const localStats = await fsLstat(localPath);
      if (!localStats.isDirectory()) {
        conflicts.push({ path: localPath, kind: 'file' });
        return;
      }
    }

    const entries = await this.readDirWithShell(remotePath);
    for (const entry of entries) {
      await this.collectDownloadConflictsForPathWithShell(entry.path, path.join(localPath, entry.name), conflicts);
    }
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

  private async createConnectedClient(config: ConnectConfig, metadata?: ConnectMetadata): Promise<SshClient> {
    const effectiveConfig: ConnectConfig =
      this.jumpClient && !config.sock
        ? { ...config, sock: await this.createJumpStream(this.jumpClient, config.host!, config.port!) }
        : config;
    const client = new Client();
    // A socket can report a second error while it is being closed after a
    // failed handshake. Keep a permanent listener so it never escapes as an
    // uncaught Electron main-process exception; the one-shot listener below
    // still rejects the connection attempt with the first useful error.
    client.on('error', () => undefined);
    let authUrl: string | null = null;

    const emitTailscaleAuthState = (message: string): void => {
      const nextUrl = extractUrl(message);
      if (nextUrl) {
        authUrl = nextUrl;
      }
      this.emitConnectionState({
        ...this.state,
        state: 'connecting',
        message,
        host: this.host ?? config.host,
        filesystemState: 'idle',
        authUrl: authUrl ?? undefined,
        recoveryHint: authUrl ? 'Open the login link, finish Tailscale verification, then wait for SSH to continue.' : undefined,
        recoverable: true,
      });
    };

    if (metadata?.authMethod === 'tailscale') {
      client.on('banner', (message) => {
        const trimmed = message.trim();
        if (trimmed !== '') {
          emitTailscaleAuthState(trimmed);
        }
      });
      client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        const lines = [name, instructions, ...prompts.map((prompt) => prompt.prompt)]
          .map((value) => value.trim())
          .filter((value) => value !== '');
        if (lines.length > 0) {
          emitTailscaleAuthState(lines.join('\n'));
        }
        finish(prompts.map(() => ''));
      });
      client.on('error', (error: Error) => {
        const message = getErrorMessage(error, 'Tailscale SSH authentication failed');
        const nextUrl = extractUrl(message);
        if (nextUrl) {
          authUrl = nextUrl;
          this.emitConnectionState({
            ...this.state,
            state: 'connecting',
            message,
            host: this.host ?? effectiveConfig.host,
            filesystemState: 'idle',
            authUrl,
            recoveryHint: 'Open the login link, finish Tailscale verification, then retry if the session does not continue.',
            recoverable: true,
          });
        }
      });
    }

    const ready = new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });

    client.connect(effectiveConfig);
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
        reason: undefined,
        diagnosticCode: undefined,
        recoveryHint: undefined,
        recoverable: true,
        authUrl: undefined,
      });
    } catch (error) {
      if (!this.interactiveClient || this.isClosing) {
        return;
      }

      this.sftp = null;
      const homeDir = await this.resolveHomeDirectoryWithShell();
      this.homeDir = homeDir;
      this.emitConnectionState({
        ...this.state,
        state: 'connected',
        message: `${getErrorMessage(error, 'Remote file system unavailable')}. Using SSH shell fallback for file operations.`,
        host,
        connectionId: this.connectionId ?? undefined,
        homeDir,
        filesystemState: 'ready',
        reason: undefined,
        diagnosticCode: undefined,
        recoveryHint: undefined,
        recoverable: true,
        authUrl: undefined,
      });
    } finally {
      this.filesystemInitPromise = null;
    }
  }

  private async createConnectedClientWithTimeout(config: ConnectConfig, timeoutMs: number): Promise<SshClient> {
    // Auxiliary sessions must follow the same route as the interactive one.
    // In particular, when a jump host is active, establish a fresh channel on
    // the already-authenticated jump connection instead of attempting a direct
    // TCP connection to the target host.
    const effectiveConfig: ConnectConfig =
      this.jumpClient && !config.sock
        ? { ...config, sock: await this.createJumpStream(this.jumpClient, config.host!, config.port!) }
        : config;

    return new Promise<SshClient>((resolve, reject) => {
      const client = new Client();
      // See createConnectedClient: this remains installed after the handshake
      // listeners have settled and protects against late ECONNRESET events.
      client.on('error', () => undefined);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        client.removeAllListeners();
        client.on('error', () => undefined);
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
        client.on('error', () => undefined);
        client.end();
        reject(error);
      };

      client.once('ready', () => {
        if (settled) {
          client.removeAllListeners();
          client.on('error', () => undefined);
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

      client.connect(effectiveConfig);
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
        const diagnostic = classifyConnectionError(error);
        this.emitConnectionState({
          ...this.state,
          state: 'error',
          message: `${diagnostic.message}. ${diagnostic.recoveryHint}`,
          host: this.host ?? undefined,
          connectionId: this.connectionId ?? undefined,
          reason: 'remote',
          diagnosticCode: diagnostic.code,
          recoveryHint: diagnostic.recoveryHint,
          recoverable: diagnostic.recoverable,
          authUrl: undefined,
        });
      }
    });
    (client as SshClient & { on: (eventName: string, listener: (...args: unknown[]) => void) => void }).on(
      'tcp connection',
      (details: unknown, accept: unknown, reject: unknown) => {
        this.handleRemoteTunnelConnection(
          details as RemoteTunnelConnectionInfo,
          accept as RemoteTunnelAccept,
          reject as RemoteTunnelReject,
        );
      },
    );
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
        client.on('error', () => undefined);
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
      console.info(`Auxiliary SSH session unavailable for ${username}@${host}: ${message}`);
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

  private async getTransferSftpHandle(): Promise<TransferSftpHandle> {
    await this.ensureAuxiliaryConnection();
    if (this.auxiliarySftp) {
      return {
        sftp: this.auxiliarySftp,
        viaShell: false,
      };
    }

    if (this.sftp) {
      return {
        sftp: this.sftp,
        viaShell: false,
      };
    }

    return {
      sftp: null,
      viaShell: true,
    };
  }

  private async ensureAuxiliaryConnection(): Promise<void> {
    if (!this.interactiveClient || !this.connectionId) {
      return;
    }

    if (this.activeConnectMetadata?.authMethod === 'tailscale') {
      this.connectionManagerState.auxiliaryState = 'failed';
      this.connectionManagerState.auxiliaryFailureReason = 'Skipped for Tailscale SSH to avoid repeated browser authentication.';
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
      tryKeyboard: config.tryKeyboard,
      authHandler: config.authHandler,
    };
  }

  private createJumpStream(client: SshClient, host: string, port: number): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });
  }

  private handleAuxiliaryDisconnect(message: string): void {
    if (this.isClosing) {
      return;
    }

    if (this.auxiliaryClient) {
      this.auxiliaryClient.removeAllListeners();
      this.auxiliaryClient.on('error', () => undefined);
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

    const terminalEntries = [...this.terminals.entries()];
    void this.idleTransfers.stopSession();
    void this.languageServers.stopAll();
    void this.stopAllTunnels().finally(() => {
      this.tunnelStates.clear();
    });
    for (const [terminalId] of terminalEntries) {
      this.flushTerminalOutput(terminalId);
    }
    this.interactiveClient = null;
    this.activeConnectConfig = null;
    this.activeConnectMetadata = null;
    this.sftp = null;
    if (this.auxiliaryClient) {
      this.auxiliaryClient.removeAllListeners();
      this.auxiliaryClient.end();
    }
    this.auxiliaryClient = null;
    this.auxiliarySftp = null;
    this.auxiliaryAttempted = false;
    this.terminals.clear();
    for (const [, terminal] of terminalEntries) {
      this.destroyTerminalSession(terminal);
    }
    this.videoStreams.clear();
    this.visionModeDisplay = null;
    this.homeDir = null;
    this.directoryCache.clear();
    this.stopHostMetrics();
    this.persistentShellKind = null;

    this.emitConnectionState({
      state: 'disconnected',
      message,
      host: this.host ?? undefined,
      connectionId: this.connectionId ?? undefined,
      filesystemState: 'idle',
      reason: 'remote',
      recoveryHint: 'Reconnect to resume file and terminal operations.',
      recoverable: true,
    });

    for (const [terminalId] of terminalEntries) {
      this.emitTerminalEvent({
        type: 'exit',
        terminalId,
      });
    }

    this.connectionId = null;
  }
}
