export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type AuthMethod = 'password' | 'privateKey' | 'agent' | 'tailscale';
export type HostVerificationMode = 'knownHosts' | 'off';
export type RemoteFileSystemState = 'idle' | 'loading' | 'ready' | 'error';
export type ConnectionStateReason = 'manual' | 'remote' | 'connectFailed';
export type ConnectionDiagnosticCode =
  | 'wrongPassword'
  | 'hostUnreachable'
  | 'knownHosts'
  | 'privateKey'
  | 'authenticationFailed'
  | 'unknown';

export interface JumpHostInput {
  host: string;
  port: number;
  username: string;
  authMethod: Exclude<AuthMethod, 'tailscale'>;
  password: string;
  privateKeyPath?: string;
  passphrase?: string;
  agentSocket?: string;
}

export interface ConnectInput {
  host: string;
  port: number;
  username: string;
  authMethod?: AuthMethod;
  password: string;
  privateKeyPath?: string;
  passphrase?: string;
  agentSocket?: string;
  hostVerification?: HostVerificationMode;
  knownHostsPath?: string;
  jumpHost?: JumpHostInput;
}

export interface ConnectResult {
  connectionId: string;
  homeDir?: string;
  filesystemState: RemoteFileSystemState;
  savedConnectionId?: string;
}

export interface SavedConnectionSummary {
  id: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
  authMethod?: AuthMethod;
  lastConnectedAt: string;
  lastWorkspacePath?: string;
  workspacePaths: string[];
  tunnels: SavedTunnelConfig[];
}

export interface TailscaleHostSummary {
  id: string;
  host: string;
  displayName: string;
  dnsName?: string;
  ip?: string;
  os?: string;
  online: boolean;
  active: boolean;
  sshUser?: string;
}

export interface ConnectionStatePayload {
  state: ConnectionState;
  message: string;
  host?: string;
  connectionId?: string;
  homeDir?: string;
  filesystemState?: RemoteFileSystemState;
  reason?: ConnectionStateReason;
  diagnosticCode?: ConnectionDiagnosticCode;
  recoveryHint?: string;
  recoverable?: boolean;
  authUrl?: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size?: number;
  modifiedAt?: number;
}

export interface RemoteFilePayload {
  path: string;
  content: string;
}

export interface SaveRemoteFileInput {
  path: string;
  content: string;
}

export interface SaveRemoteFileResult {
  path: string;
  savedAt: string;
}

export interface CreateRemoteEntryInput {
  parentPath: string;
  name: string;
  kind: 'directory' | 'file';
}

export interface RenameRemoteEntryInput {
  path: string;
  nextName: string;
}

export interface DeleteRemoteEntryInput {
  path: string;
  operationId?: string;
}

export type FileOperationKind = 'upload' | 'download' | 'delete';
export type FileOperationStatus = 'running' | 'completed' | 'failed' | 'canceled';
export type FileConflictStrategy = 'ask' | 'overwrite' | 'skip';
export type FileTransferTransport = 'sftp' | 'rsync' | 'shell';

export interface FileConflictItem {
  path: string;
  kind: 'file' | 'directory';
}

export interface FileOperationEvent {
  operationId: string;
  kind: FileOperationKind;
  status: FileOperationStatus;
  sourcePath: string;
  targetPath: string;
  message: string;
  completedItems: number;
  totalItems: number;
  skippedItems: number;
  currentPath?: string;
  error?: string;
  retryable?: boolean;
  /** Bytes transferred so far across the whole operation, when known. */
  transferredBytes?: number;
  /** Total bytes the operation expects to move, when known. */
  totalBytes?: number;
  /** Recent throughput in bytes per second, when measurable. */
  bytesPerSecond?: number;
  /** Estimated seconds remaining at the current rate, when measurable. */
  etaSeconds?: number;
  /** Which mechanism moved the bytes. */
  transport?: FileTransferTransport;
}

export interface TransferCapabilities {
  /** A usable rsync binary exists on this machine. */
  localRsync: boolean;
  /** rsync is installed on the connected remote host. */
  remoteRsync: boolean;
}

export interface UploadLocalEntriesInput {
  operationId: string;
  remotePath: string;
  localPaths: string[];
  conflictStrategy?: FileConflictStrategy;
}

export interface DownloadRemoteEntryInput {
  operationId: string;
  remotePath: string;
  localPath: string;
  conflictStrategy?: FileConflictStrategy;
}

export type FileOperationResult =
  | {
      status: 'completed';
      skippedItems: number;
    }
  | {
      status: 'conflict';
      conflicts: FileConflictItem[];
    };

export interface SearchRemoteFilesInput {
  rootPath: string;
  query: string;
  caseSensitive: boolean;
  maxResults?: number;
}

export interface SearchRemoteMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchRemoteFilesResult {
  query: string;
  matches: SearchRemoteMatch[];
  truncated: boolean;
}

export type PersistentShellKind = 'tmux' | 'screen' | 'none';

export interface RemoteShellSessionSummary {
  name: string;
  attached: boolean;
  windows?: number;
  createdAt?: number;
}

export interface RemoteShellSupport {
  kind: PersistentShellKind;
  sessions: RemoteShellSessionSummary[];
}

export interface CreateTerminalInput {
  /**
   * Run the shell inside a persistent multiplexer session with this name,
   * attaching to it when it already exists. Ignored when the remote host has no
   * multiplexer available.
   */
  sessionName?: string;
  workspacePath?: string;
}

export interface CreateTerminalResult {
  terminalId: string;
  /** Set when the shell runs inside a persistent multiplexer session. */
  sessionName?: string;
  persistentKind?: PersistentShellKind;
}

export interface HostGpuProcess {
  pid: number;
  memoryUsedMb?: number;
  name?: string;
}

export interface HostGpuSnapshot {
  index: number;
  name: string;
  utilization?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  temperature?: number;
  powerDrawWatts?: number;
  powerLimitWatts?: number;
  processes: HostGpuProcess[];
}

export interface HostDiskUsage {
  mountPath: string;
  totalMb: number;
  availableMb: number;
}

export interface HostMetricsSnapshot {
  collectedAt: number;
  gpus: HostGpuSnapshot[];
  /** False on hosts without nvidia-smi, so the UI can hide the GPU section. */
  gpuAvailable: boolean;
  loadAverage?: [number, number, number];
  cpuCount?: number;
  memory?: {
    totalMb: number;
    availableMb: number;
  };
  disk?: HostDiskUsage;
}

export interface HostMetricsEvent {
  connectionId: string;
  snapshot?: HostMetricsSnapshot;
  error?: string;
}

export interface ReadRemoteBinaryFileInput {
  path: string;
  /** Reject files larger than this instead of streaming them into the renderer. */
  maxBytes?: number;
}

export interface RemoteBinaryFilePayload {
  path: string;
  /** Base64 so the payload survives the structured-clone IPC boundary intact. */
  base64: string;
  byteLength: number;
  modifiedAt?: number;
}

export interface IdleTransferSnapshot {
  queuedItems: number;
  /** Paths waiting behind the current idle transfer. */
  queuedPaths: string[];
  activePath?: string;
  cachedBytes: number;
  /** Automatic preview cache is hard-capped at 3 GiB. */
  cacheLimitBytes: number;
  manualGroups: IdleTransferGroup[];
}

export interface IdleTransferGroup {
  rootPath: string;
  activePath?: string;
  queuedPaths: string[];
}

export interface QueueIdleDownloadInput {
  remotePath: string;
  /** Full local destination. When omitted, the main process opens a folder picker. */
  localPath?: string;
}

export interface EnsureVirtualDisplayResult {
  display: string;
  alreadyRunning: boolean;
}

export interface StartVideoStreamInput {
  display: string;
  width: number;
  height: number;
  fps: number;
  quality: number;
}

export interface StartVideoStreamResult {
  streamId: string;
}

export interface VideoFrameEvent {
  streamId: string;
  data: Uint8Array;
  seq: number;
}

export interface VideoStreamStateEvent {
  streamId: string;
  status: 'running' | 'stopped' | 'error';
  message?: string;
}

export interface EnableVisionModeResult {
  display: string;
}

export type TunnelKind = 'local' | 'remote' | 'dynamic';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

interface SavedTunnelConfigBase {
  id: string;
  name: string;
  kind: TunnelKind;
}

export interface SavedLocalTunnelConfig extends SavedTunnelConfigBase {
  kind: 'local';
  localHost: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}

export interface SavedRemoteTunnelConfig extends SavedTunnelConfigBase {
  kind: 'remote';
  remoteHost: string;
  remotePort: number;
  targetHost: string;
  targetPort: number;
}

export interface SavedDynamicTunnelConfig extends SavedTunnelConfigBase {
  kind: 'dynamic';
  localHost: string;
  localPort: number;
}

export type SavedTunnelConfig =
  | SavedLocalTunnelConfig
  | SavedRemoteTunnelConfig
  | SavedDynamicTunnelConfig;

export interface TunnelRuntimeState {
  id: string;
  status: TunnelStatus;
  message?: string;
}

export interface TunnelSnapshot {
  config: SavedTunnelConfig;
  state: TunnelRuntimeState;
}

export type TerminalEvent =
  | {
      type: 'data';
      terminalId: string;
      data: string;
    }
  | {
      type: 'exit';
      terminalId: string;
    }
  | {
      type: 'error';
      terminalId: string;
      message: string;
    };

export interface TunnelEvent {
  type: 'state';
  state: TunnelRuntimeState;
}

export type LanguageServerLanguage = 'typescript';
export type LanguageServerStatus = 'starting' | 'ready' | 'stopped' | 'unavailable' | 'error';
export type LanguageServerFeature = 'completion' | 'hover' | 'definition';

export interface StartLanguageServerInput {
  workspacePath: string;
  language: LanguageServerLanguage;
}

export interface StartLanguageServerResult {
  sessionId: string;
  workspacePath: string;
  language: LanguageServerLanguage;
}

export interface LanguageServerDocumentInput {
  sessionId: string;
  remotePath: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LanguageServerDocumentChangeInput {
  sessionId: string;
  remotePath: string;
  version: number;
  contentChanges: Array<{
    range?: LanguageServerRange;
    rangeLength?: number;
    text: string;
  }>;
}

export interface LanguageServerDocumentReference {
  sessionId: string;
  remotePath: string;
}

export interface LanguageServerPosition {
  line: number;
  character: number;
}

export interface LanguageServerFeatureInput extends LanguageServerDocumentReference {
  feature: LanguageServerFeature;
  position: LanguageServerPosition;
}

export interface LanguageServerRange {
  start: LanguageServerPosition;
  end: LanguageServerPosition;
}

export interface LanguageServerDiagnostic {
  range: LanguageServerRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LanguageServerDiagnosticsEvent {
  sessionId: string;
  remotePath: string;
  diagnostics: LanguageServerDiagnostic[];
}

export interface LanguageServerStateEvent {
  sessionId?: string;
  workspacePath: string;
  language: LanguageServerLanguage;
  status: LanguageServerStatus;
  message: string;
}

export const IPC_CHANNELS = {
  openNewWindow: 'window:openNew',
  openExternal: 'shell:openExternal',
  clipboardReadText: 'clipboard:readText',
  clipboardWriteText: 'clipboard:writeText',
  connect: 'ssh:connect',
  connectSaved: 'ssh:connectSaved',
  disconnect: 'ssh:disconnect',
  tailscaleHostsList: 'tailscale:listHosts',
  savedConnectionsList: 'savedConnections:list',
  savedConnectionsRemove: 'savedConnections:remove',
  savedConnectionsRename: 'savedConnections:rename',
  savedConnectionsUpdateWorkspace: 'savedConnections:updateWorkspace',
  readDir: 'sftp:readDir',
  readFile: 'sftp:readFile',
  writeFileAtomic: 'sftp:writeFileAtomic',
  createEntry: 'sftp:createEntry',
  renameEntry: 'sftp:renameEntry',
  deleteEntry: 'sftp:deleteEntry',
  uploadLocalEntries: 'sftp:uploadLocalEntries',
  downloadEntry: 'sftp:downloadEntry',
  cancelFileOperation: 'sftp:cancelFileOperation',
  getTransferCapabilities: 'sftp:getTransferCapabilities',
  pickDownloadDirectory: 'dialog:pickDownloadDirectory',
  searchInFiles: 'ssh:searchInFiles',
  pickPrivateKeyPath: 'dialog:pickPrivateKeyPath',
  pickKnownHostsPath: 'dialog:pickKnownHostsPath',
  pickUploadEntries: 'dialog:pickUploadEntries',
  readBinaryFile: 'sftp:readBinaryFile',
  startAutomaticMediaCache: 'sftp:startAutomaticMediaCache',
  queueIdleDownload: 'sftp:queueIdleDownload',
  idleTransferSnapshot: 'sftp:idleTransferSnapshot',
  cancelIdleDownload: 'sftp:cancelIdleDownload',
  cancelIdleDownloadGroup: 'sftp:cancelIdleDownloadGroup',
  terminalCreate: 'terminal:create',
  terminalShellSupport: 'terminal:shellSupport',
  terminalKillSession: 'terminal:killSession',
  hostMetricsStart: 'hostMetrics:start',
  hostMetricsStop: 'hostMetrics:stop',
  hostMetricsRefresh: 'hostMetrics:refresh',
  hostMetricsEvent: 'hostMetrics:event',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalEvent: 'terminal:event',
  tunnelsList: 'tunnels:list',
  tunnelsSave: 'tunnels:save',
  tunnelsRemove: 'tunnels:remove',
  tunnelsStart: 'tunnels:start',
  tunnelsStop: 'tunnels:stop',
  tunnelEvent: 'tunnel:event',
  connectionState: 'connection:state',
  fileOperationEvent: 'fileOperation:event',
  visionModeEnable: 'vision:enable',
  visionModeDisable: 'vision:disable',
  videoStreamStart: 'video:streamStart',
  videoStreamStop: 'video:streamStop',
  videoObserverResize: 'video:observerResize',
  videoFrameEvent: 'video:frame',
  videoStreamStateEvent: 'video:streamState',
  languageServerStart: 'languageServer:start',
  languageServerStop: 'languageServer:stop',
  languageServerDocumentOpen: 'languageServer:documentOpen',
  languageServerDocumentChange: 'languageServer:documentChange',
  languageServerDocumentSave: 'languageServer:documentSave',
  languageServerDocumentClose: 'languageServer:documentClose',
  languageServerFeature: 'languageServer:feature',
  languageServerDiagnosticsEvent: 'languageServer:diagnostics',
  languageServerStateEvent: 'languageServer:state',
} as const;
