import type {
  DeleteRemoteEntryInput,
  CreateTerminalResult,
  CreateRemoteEntryInput,
  ConnectInput,
  ConnectResult,
  ConnectionStatePayload,
  RenameRemoteEntryInput,
  RemoteDirectoryEntry,
  RemoteFilePayload,
  SavedConnectionSummary,
  SaveRemoteFileInput,
  SaveRemoteFileResult,
  SearchRemoteFilesInput,
  SearchRemoteFilesResult,
  TerminalEvent,
} from './contracts';

export interface ElectronApi {
  openNewWindow: () => Promise<void>;
  connect: (input: ConnectInput) => Promise<ConnectResult>;
  connectSaved: (savedConnectionId: string) => Promise<ConnectResult>;
  disconnect: () => Promise<void>;
  listSavedConnections: () => Promise<SavedConnectionSummary[]>;
  removeSavedConnection: (savedConnectionId: string) => Promise<void>;
  renameSavedConnection: (savedConnectionId: string, displayName: string) => Promise<void>;
  updateSavedConnectionWorkspace: (savedConnectionId: string, workspacePath: string) => Promise<void>;
  readDir: (remotePath: string) => Promise<RemoteDirectoryEntry[]>;
  readFile: (remotePath: string) => Promise<RemoteFilePayload>;
  writeFileAtomic: (input: SaveRemoteFileInput) => Promise<SaveRemoteFileResult>;
  createEntry: (input: CreateRemoteEntryInput) => Promise<RemoteDirectoryEntry>;
  renameEntry: (input: RenameRemoteEntryInput) => Promise<RemoteDirectoryEntry>;
  deleteEntry: (input: DeleteRemoteEntryInput) => Promise<void>;
  uploadLocalEntries: (remotePath: string, localPaths?: string[]) => Promise<void>;
  downloadEntry: (remotePath: string) => Promise<void>;
  searchInFiles: (input: SearchRemoteFilesInput) => Promise<SearchRemoteFilesResult>;
  pickPrivateKeyPath: () => Promise<string | null>;
  pickKnownHostsPath: () => Promise<string | null>;
  pickUploadEntries: () => Promise<string[]>;
  createTerminal: () => Promise<CreateTerminalResult>;
  writeTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (terminalId: string) => Promise<void>;
  onTerminalEvent: (callback: (event: TerminalEvent) => void) => () => void;
  onConnectionState: (callback: (state: ConnectionStatePayload) => void) => () => void;
}
