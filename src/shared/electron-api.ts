import type {
  DeleteRemoteEntryInput,
  CreateTerminalResult,
  CreateRemoteEntryInput,
  ConnectInput,
  ConnectResult,
  ConnectionStatePayload,
  DownloadRemoteEntryInput,
  EnableVisionModeResult,
  FileOperationEvent,
  FileOperationResult,
  LanguageServerDiagnosticsEvent,
  LanguageServerDocumentChangeInput,
  LanguageServerDocumentInput,
  LanguageServerDocumentReference,
  LanguageServerFeatureInput,
  LanguageServerStateEvent,
  RenameRemoteEntryInput,
  RemoteDirectoryEntry,
  RemoteFilePayload,
  SavedConnectionSummary,
  SaveRemoteFileInput,
  SaveRemoteFileResult,
  SavedTunnelConfig,
  SearchRemoteFilesInput,
  SearchRemoteFilesResult,
  StartVideoStreamInput,
  StartVideoStreamResult,
  StartLanguageServerInput,
  StartLanguageServerResult,
  TailscaleHostSummary,
  TerminalEvent,
  TunnelEvent,
  TunnelSnapshot,
  UploadLocalEntriesInput,
  VideoFrameEvent,
  VideoStreamStateEvent,
} from './contracts';

export interface ElectronApi {
  openNewWindow: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  connect: (input: ConnectInput) => Promise<ConnectResult>;
  connectSaved: (savedConnectionId: string) => Promise<ConnectResult>;
  disconnect: () => Promise<void>;
  listTailscaleHosts: () => Promise<TailscaleHostSummary[]>;
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
  uploadLocalEntries: (input: UploadLocalEntriesInput) => Promise<FileOperationResult>;
  downloadEntry: (input: DownloadRemoteEntryInput) => Promise<FileOperationResult>;
  searchInFiles: (input: SearchRemoteFilesInput) => Promise<SearchRemoteFilesResult>;
  pickPrivateKeyPath: () => Promise<string | null>;
  pickKnownHostsPath: () => Promise<string | null>;
  pickUploadEntries: () => Promise<string[]>;
  pickDownloadDirectory: () => Promise<string | null>;
  createTerminal: () => Promise<CreateTerminalResult>;
  writeTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (terminalId: string) => Promise<void>;
  listTunnels: (savedConnectionId: string) => Promise<TunnelSnapshot[]>;
  saveTunnel: (savedConnectionId: string, tunnel: SavedTunnelConfig) => Promise<void>;
  removeTunnel: (savedConnectionId: string, tunnelId: string) => Promise<void>;
  startTunnel: (savedConnectionId: string, tunnelId: string) => Promise<void>;
  stopTunnel: (tunnelId: string) => Promise<void>;
  onTerminalEvent: (callback: (event: TerminalEvent) => void) => () => void;
  onTunnelEvent: (callback: (event: TunnelEvent) => void) => () => void;
  onConnectionState: (callback: (state: ConnectionStatePayload) => void) => () => void;
  onFileOperationEvent: (callback: (event: FileOperationEvent) => void) => () => void;
  enableVisionMode: (display?: string) => Promise<EnableVisionModeResult>;
  disableVisionMode: () => Promise<void>;
  startVideoStream: (input: StartVideoStreamInput) => Promise<StartVideoStreamResult>;
  stopVideoStream: (streamId: string) => Promise<void>;
  resizeVideoObserver: (streamId: string, width: number, height: number) => Promise<void>;
  onVideoFrame: (callback: (event: VideoFrameEvent) => void) => () => void;
  onVideoStreamState: (callback: (event: VideoStreamStateEvent) => void) => () => void;
  startLanguageServer: (input: StartLanguageServerInput) => Promise<StartLanguageServerResult>;
  stopLanguageServer: (sessionId: string) => Promise<void>;
  openLanguageDocument: (input: LanguageServerDocumentInput) => Promise<void>;
  changeLanguageDocument: (input: LanguageServerDocumentChangeInput) => Promise<void>;
  saveLanguageDocument: (input: LanguageServerDocumentReference) => Promise<void>;
  closeLanguageDocument: (input: LanguageServerDocumentReference) => Promise<void>;
  requestLanguageFeature: (input: LanguageServerFeatureInput) => Promise<unknown>;
  onLanguageServerDiagnostics: (callback: (event: LanguageServerDiagnosticsEvent) => void) => () => void;
  onLanguageServerState: (callback: (event: LanguageServerStateEvent) => void) => () => void;
}
