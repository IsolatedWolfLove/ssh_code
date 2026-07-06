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
export type FileOperationStatus = 'running' | 'completed' | 'failed';
export type FileConflictStrategy = 'ask' | 'overwrite' | 'skip';

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

export interface CreateTerminalResult {
  terminalId: string;
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

export const IPC_CHANNELS = {
  openNewWindow: 'window:openNew',
  openExternal: 'shell:openExternal',
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
  pickDownloadDirectory: 'dialog:pickDownloadDirectory',
  searchInFiles: 'ssh:searchInFiles',
  pickPrivateKeyPath: 'dialog:pickPrivateKeyPath',
  pickKnownHostsPath: 'dialog:pickKnownHostsPath',
  pickUploadEntries: 'dialog:pickUploadEntries',
  terminalCreate: 'terminal:create',
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
  videoFrameEvent: 'video:frame',
  videoStreamStateEvent: 'video:streamState',
} as const;
