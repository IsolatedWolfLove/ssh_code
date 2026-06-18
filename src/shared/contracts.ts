export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type AuthMethod = 'password' | 'privateKey' | 'agent';
export type HostVerificationMode = 'knownHosts' | 'off';
export type RemoteFileSystemState = 'idle' | 'loading' | 'ready' | 'error';

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
}

export interface ConnectionStatePayload {
  state: ConnectionState;
  message: string;
  host?: string;
  connectionId?: string;
  homeDir?: string;
  filesystemState?: RemoteFileSystemState;
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
}

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

export const IPC_CHANNELS = {
  openNewWindow: 'window:openNew',
  connect: 'ssh:connect',
  connectSaved: 'ssh:connectSaved',
  disconnect: 'ssh:disconnect',
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
  searchInFiles: 'ssh:searchInFiles',
  pickPrivateKeyPath: 'dialog:pickPrivateKeyPath',
  pickKnownHostsPath: 'dialog:pickKnownHostsPath',
  pickUploadEntries: 'dialog:pickUploadEntries',
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalEvent: 'terminal:event',
  connectionState: 'connection:state',
} as const;
