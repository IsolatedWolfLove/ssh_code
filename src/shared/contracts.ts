export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectInput {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ConnectResult {
  connectionId: string;
  homeDir: string;
  savedConnectionId?: string;
}

export interface SavedConnectionSummary {
  id: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
  lastConnectedAt: string;
  lastWorkspacePath?: string;
  workspacePaths: string[];
}

export interface ConnectionStatePayload {
  state: ConnectionState;
  message: string;
  host?: string;
  connectionId?: string;
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
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalEvent: 'terminal:event',
  connectionState: 'connection:state',
} as const;
