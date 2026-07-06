import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../shared/contracts';
import type { ElectronApi } from '../shared/electron-api';

const electronApi: ElectronApi = {
  openNewWindow: () => ipcRenderer.invoke(IPC_CHANNELS.openNewWindow),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  connect: (input) => ipcRenderer.invoke(IPC_CHANNELS.connect, input),
  connectSaved: (savedConnectionId) => ipcRenderer.invoke(IPC_CHANNELS.connectSaved, savedConnectionId),
  disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.disconnect),
  listTailscaleHosts: () => ipcRenderer.invoke(IPC_CHANNELS.tailscaleHostsList),
  listSavedConnections: () => ipcRenderer.invoke(IPC_CHANNELS.savedConnectionsList),
  removeSavedConnection: (savedConnectionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.savedConnectionsRemove, savedConnectionId),
  renameSavedConnection: (savedConnectionId, displayName) =>
    ipcRenderer.invoke(IPC_CHANNELS.savedConnectionsRename, savedConnectionId, displayName),
  updateSavedConnectionWorkspace: (savedConnectionId, workspacePath) =>
    ipcRenderer.invoke(IPC_CHANNELS.savedConnectionsUpdateWorkspace, savedConnectionId, workspacePath),
  readDir: (remotePath) => ipcRenderer.invoke(IPC_CHANNELS.readDir, remotePath),
  readFile: (remotePath) => ipcRenderer.invoke(IPC_CHANNELS.readFile, remotePath),
  writeFileAtomic: (input) => ipcRenderer.invoke(IPC_CHANNELS.writeFileAtomic, input),
  createEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.createEntry, input),
  renameEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.renameEntry, input),
  deleteEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.deleteEntry, input),
  uploadLocalEntries: (input) => ipcRenderer.invoke(IPC_CHANNELS.uploadLocalEntries, input),
  downloadEntry: (input) => ipcRenderer.invoke(IPC_CHANNELS.downloadEntry, input),
  searchInFiles: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchInFiles, input),
  pickPrivateKeyPath: () => ipcRenderer.invoke(IPC_CHANNELS.pickPrivateKeyPath),
  pickKnownHostsPath: () => ipcRenderer.invoke(IPC_CHANNELS.pickKnownHostsPath),
  pickUploadEntries: () => ipcRenderer.invoke(IPC_CHANNELS.pickUploadEntries),
  pickDownloadDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.pickDownloadDirectory),
  createTerminal: () => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke(IPC_CHANNELS.terminalWrite, terminalId, data),
  resizeTerminal: (terminalId, cols, rows) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalResize, terminalId, cols, rows),
  closeTerminal: (terminalId) => ipcRenderer.invoke(IPC_CHANNELS.terminalClose, terminalId),
  listTunnels: (savedConnectionId) => ipcRenderer.invoke(IPC_CHANNELS.tunnelsList, savedConnectionId),
  saveTunnel: (savedConnectionId, tunnel) => ipcRenderer.invoke(IPC_CHANNELS.tunnelsSave, savedConnectionId, tunnel),
  removeTunnel: (savedConnectionId, tunnelId) =>
    ipcRenderer.invoke(IPC_CHANNELS.tunnelsRemove, savedConnectionId, tunnelId),
  startTunnel: (savedConnectionId, tunnelId) =>
    ipcRenderer.invoke(IPC_CHANNELS.tunnelsStart, savedConnectionId, tunnelId),
  stopTunnel: (tunnelId) => ipcRenderer.invoke(IPC_CHANNELS.tunnelsStop, tunnelId),
  onTerminalEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => {
      callback(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.terminalEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.terminalEvent, listener);
    };
  },
  onTunnelEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => {
      callback(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.tunnelEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.tunnelEvent, listener);
    };
  },
  onConnectionState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => {
      callback(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.connectionState, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.connectionState, listener);
    };
  },
  onFileOperationEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => {
      callback(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.fileOperationEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.fileOperationEvent, listener);
    };
  },
  enableVisionMode: (display) => ipcRenderer.invoke(IPC_CHANNELS.visionModeEnable, display),
  disableVisionMode: () => ipcRenderer.invoke(IPC_CHANNELS.visionModeDisable),
  startVideoStream: (input) => ipcRenderer.invoke(IPC_CHANNELS.videoStreamStart, input),
  stopVideoStream: (streamId) => ipcRenderer.invoke(IPC_CHANNELS.videoStreamStop, streamId),
  resizeVideoObserver: (streamId, width, height) =>
    ipcRenderer.invoke(IPC_CHANNELS.videoObserverResize, streamId, width, height),
  onVideoFrame: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => {
      callback(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.videoFrameEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.videoFrameEvent, listener);
    };
  },
  onVideoStreamState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => {
      callback(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.videoStreamStateEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.videoStreamStateEvent, listener);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronApi);
