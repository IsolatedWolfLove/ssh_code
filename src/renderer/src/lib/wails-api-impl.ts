import type { ElectronApi } from '../../../shared/electron-api';
import type { ConnectResult, ConnectionStatePayload, VideoFrameEvent } from '../../../shared/contracts';

// Keep the renderer build independent of generated, ignored Wails files.
// Wails injects these APIs before loading the application bundle.
type WailsWindow = Window & {
  go: { app: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } };
  runtime: { EventsOnMultiple: (name: string, callback: (value: never) => void, count: number) => () => void };
};
let connectionId: string | null = null;
const backend = () => (window as unknown as WailsWindow).go.app.App;
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return await backend()[method](...args) as T;
}
async function connected<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!connectionId) throw new Error('No active SSH connection');
  return call<T>(method, connectionId, ...args);
}
function on<T>(name: string, callback: (payload: T) => void): () => void {
  return (window as unknown as WailsWindow).runtime.EventsOnMultiple(name, callback, -1);
}
const api: ElectronApi = {
  connect: async (input) => {
    const result = await call<ConnectResult>('Connect', input);
    connectionId = result.connectionId;
    return result;
  },
  connectSaved: async (id) => {
    const result = await call<ConnectResult>('ConnectSaved', id);
    connectionId = result.connectionId;
    return result;
  },
  disconnect: async () => {
    if (!connectionId) return;
    const id = connectionId;
    try { await call<void>('Disconnect', id); }
    finally { if (connectionId === id) connectionId = null; }
  },
  onConnectionState: (callback) => on<ConnectionStatePayload>('connection:state', (event) => {
    if (event.state === 'connected' && event.connectionId) connectionId = event.connectionId;
    callback(event);
  }),
  onVideoFrame: (callback) => on<Omit<VideoFrameEvent, 'data'> & { data: string }>('video:frame', (event) => {
    callback({ ...event, data: Uint8Array.from(atob(event.data), c => c.charCodeAt(0)) });
  }),
  openNewWindow: () => call('OpenNewWindow'),
  openExternal: (url) => call('OpenExternal', url),
  readClipboardText: () => call('ReadClipboardText'),
  writeClipboardText: (text) => call('WriteClipboardText', text),
  getSavedConnectionInput: (id) => call('GetSavedConnectionInput', id),
  listTailscaleHosts: () => call('ListTailscaleHosts'),
  listSavedConnections: () => call('ListSavedConnections'),
  removeSavedConnection: (id) => call('RemoveSavedConnection', id),
  renameSavedConnection: (id, name) => call('RenameSavedConnection', id, name),
  updateSavedConnectionWorkspace: (id, workspace) => call('UpdateSavedConnectionWorkspace', id, workspace),
  importSshConfig: () => call('ImportSshConfig'),
  cancelFileOperation: (id) => call('CancelFileOperation', id),
  pickUploadEntries: () => call('PickUploadEntries'),
  writeTerminal: (id, data) => call('WriteTerminal', id, data),
  resizeTerminal: (id, cols, rows) => call('ResizeTerminal', id, cols, rows),
  closeTerminal: (id) => call('CloseTerminal', id),
  listTunnels: (id) => call('ListTunnels', id),
  saveTunnel: (id, config) => call('SaveTunnel', id, config),
  removeTunnel: (id, tunnelId) => call('RemoveTunnel', id, tunnelId),
  readDir: (path) => connected('ReadDir', path),
  readFile: (path) => connected('ReadFile', path),
  readBinaryFile: (input) => connected('ReadBinaryFile', input),
  startAutomaticMediaCache: (path) => connected('StartAutomaticMediaCache', path),
  queueIdleDownload: (input) => connected('QueueIdleDownload', input),
  getIdleTransferSnapshot: () => connected('GetIdleTransferSnapshot'),
  cancelIdleDownload: (path) => connected('CancelIdleDownload', path),
  cancelIdleDownloadGroup: (path) => connected('CancelIdleDownloadGroup', path),
  writeFileAtomic: (input) => connected('WriteFileAtomic', input),
  createEntry: (input) => connected('CreateEntry', input),
  renameEntry: (input) => connected('RenameEntry', input),
  deleteEntry: (input) => connected('DeleteEntry', input),
  uploadLocalEntries: (input) => connected('UploadLocalEntries', input),
  downloadEntry: (input) => connected('DownloadEntry', input),
  getTransferCapabilities: () => connected('GetTransferCapabilities'),
  searchInFiles: (input) => connected('SearchInFiles', input),
  getRemoteShellSupport: () => connected('GetRemoteShellSupport'),
  killRemoteShellSession: (name) => connected('KillRemoteShellSession', name),
  stopHostMetrics: () => connected('StopHostMetrics'),
  refreshHostMetrics: (workspace) => connected('RefreshHostMetrics', workspace),
  startTunnel: (savedId, tunnelId) => connected('StartTunnel', savedId, tunnelId),
  stopTunnel: (id) => connected('StopTunnel', id),
  disableVisionMode: () => connected('DisableVisionMode'),
  startVideoStream: (input) => connected('StartVideoStream', input),
  stopVideoStream: (id) => connected('StopVideoStream', id),
  resizeVideoObserver: async (_id, width, height) => {
    const panel = document.querySelector<HTMLElement>('.wails-video-overlay');
    if (panel) { panel.style.maxWidth = `${width}px`; panel.style.maxHeight = `${height}px`; }
  },
  startLanguageServer: (input) => connected('StartLanguageServer', input),
  stopLanguageServer: (id) => connected('StopLanguageServer', id),
  openLanguageDocument: (input) => connected('OpenLanguageDocument', input),
  changeLanguageDocument: (input) => connected('ChangeLanguageDocument', input),
  saveLanguageDocument: (input) => connected('SaveLanguageDocument', input),
  closeLanguageDocument: (input) => connected('CloseLanguageDocument', input),
  requestLanguageFeature: (input) => connected('RequestLanguageFeature', input),
  pickPrivateKeyPath: async () => (await call<string>('PickPrivateKeyPath')) || null,
  pickKnownHostsPath: async () => (await call<string>('PickKnownHostsPath')) || null,
  pickDownloadDirectory: async () => (await call<string>('PickDownloadDirectory')) || null,
  createTerminal: (input) => connected('CreateTerminal', input ?? {}),
  startHostMetrics: (workspace, interval) => connected('StartHostMetrics', workspace, interval ?? 5000),
  enableVisionMode: (display) => connected('EnableVisionMode', display ?? ':99'),
  onTerminalEvent: callback => on('terminal:event', callback),
  onTunnelEvent: callback => on('tunnel:event', callback),
  onFileOperationEvent: callback => on('fileOperation:event', callback),
  onHostMetrics: callback => on('hostMetrics:event', callback),
  onVideoStreamState: callback => on('video:state', callback),
  onLanguageServerDiagnostics: callback => on('languageServer:diagnostics', callback),
  onLanguageServerState: callback => on('languageServer:state', callback),
};
export default api;
