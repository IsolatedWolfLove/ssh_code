import path from 'node:path';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';

import { IPC_CHANNELS } from '../shared/contracts';
import type {
  ConnectInput,
  CreateRemoteEntryInput,
  CreateTerminalInput,
  DeleteRemoteEntryInput,
  ReadRemoteBinaryFileInput,
  DownloadRemoteEntryInput,
  FileOperationEvent,
  FileOperationResult,
  LanguageServerDocumentChangeInput,
  LanguageServerDocumentInput,
  LanguageServerDocumentReference,
  LanguageServerFeatureInput,
  QueueIdleDownloadInput,
  RenameRemoteEntryInput,
  SavedTunnelConfig,
  SaveRemoteFileInput,
  SearchRemoteFilesInput,
  StartVideoStreamInput,
  StartLanguageServerInput,
  TailscaleHostSummary,
  TransferCapabilities,
  UploadLocalEntriesInput,
} from '../shared/contracts';
import { SavedConnectionStore } from './saved-connections';
import { SshSessionManager } from './ssh-session';

interface WindowSession {
  window: BrowserWindow;
  sessionManager: SshSessionManager;
  unsubscribeConnectionState: () => void;
  unsubscribeTerminalEvent: () => void;
  unsubscribeTunnelEvent: () => void;
  unsubscribeFileOperationEvent: () => void;
  unsubscribeHostMetricsEvent: () => void;
  unsubscribeVideoFrameEvent: () => void;
  unsubscribeVideoStreamStateEvent: () => void;
  unsubscribeLanguageServerDiagnostics: () => void;
  unsubscribeLanguageServerState: () => void;
}

const windowSessions = new Map<number, WindowSession>();
// streamId -> observer window showing that stream's frames.
const videoObserverWindows = new Map<string, BrowserWindow>();
// streamId -> webContentsId of the main window that owns the underlying SSH session/stream.
const videoStreamOwners = new Map<string, number>();
let ipcRegistered = false;
let savedConnectionStore: SavedConnectionStore | null = null;
const execFileAsync = promisify(execFile);

let cachedLocalRsync: boolean | null = null;

// The delta fast-path needs a local rsync binary to drive the transfer. This is
// a per-machine fact, so probe once and cache it. Windows generally lacks rsync,
// which is fine: the SFTP resumable engine is the fallback everywhere.
async function detectLocalRsync(): Promise<boolean> {
  if (cachedLocalRsync !== null) {
    return cachedLocalRsync;
  }

  try {
    await execFileAsync('rsync', ['--version'], { timeout: 4000 });
    cachedLocalRsync = true;
  } catch {
    cachedLocalRsync = false;
  }

  return cachedLocalRsync;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function getCommandErrorMessage(error: unknown, fallback: string): string {
  if (isRecord(error)) {
    const stderr = readString(error, 'stderr').trim();
    if (stderr !== '') {
      return stderr;
    }
    const message = readString(error, 'message').trim();
    if (message !== '') {
      return message;
    }
  }

  return fallback;
}

function normalizeDnsName(value: string): string {
  return value.replace(/\.$/, '');
}

function toTailscaleHostSummary(id: string, value: unknown): TailscaleHostSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const dnsName = normalizeDnsName(readString(value, 'DNSName'));
  const hostName = readString(value, 'HostName');
  const ip = readStringArray(value, 'TailscaleIPs')[0] ?? '';
  const host = ip || dnsName || hostName;
  if (host === '') {
    return null;
  }

  return {
    id,
    host,
    displayName: hostName || dnsName.split('.')[0] || host,
    dnsName: dnsName || undefined,
    ip: ip || undefined,
    os: readString(value, 'OS') || undefined,
    online: readBoolean(value, 'Online'),
    active: readBoolean(value, 'Active'),
    sshUser: os.userInfo().username || undefined,
  };
}

async function listTailscaleHosts(): Promise<TailscaleHostSummary[]> {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(stdout) as unknown;
    const peerMap = isRecord(payload) && isRecord(payload.Peer) ? payload.Peer : {};

    return Object.entries(peerMap)
      .map(([id, value]) => toTailscaleHostSummary(id, value))
      .filter((item): item is TailscaleHostSummary => item !== null)
      .sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }
        if (left.active !== right.active) {
          return left.active ? -1 : 1;
        }
        return left.displayName.localeCompare(right.displayName);
      });
  } catch (error) {
    throw new Error(getCommandErrorMessage(error, 'Unable to load Tailscale hosts'));
  }
}

function canAccessPath(devicePath: string): boolean {
  try {
    accessSync(devicePath, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasUsableLinuxGpuDevice(): boolean {
  const directCandidates = ['/dev/nvidiactl', '/dev/kfd'];
  if (directCandidates.some(canAccessPath)) {
    return true;
  }

  try {
    const driEntries = readdirSync('/dev/dri', { withFileTypes: true })
      .filter((entry) => entry.isCharacterDevice?.() ?? true)
      .map((entry) => path.join('/dev/dri', entry.name))
      .filter((devicePath) => {
        const fileName = path.basename(devicePath);
        return fileName.startsWith('renderD') || fileName.startsWith('card');
      });

    return driEntries.some(canAccessPath);
  } catch {
    return false;
  }
}

function shouldDisableHardwareAcceleration(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }

  if (process.env.SSH_STUDIO_AUTO_DISABLE_GPU !== '0') {
    return true;
  }

  if (process.env.SSH_STUDIO_FORCE_GPU === '1') {
    return false;
  }

  if (process.env.SSH_STUDIO_DISABLE_GPU === '1') {
    return true;
  }

  return !hasUsableLinuxGpuDevice();
}

if (shouldDisableHardwareAcceleration()) {
  app.disableHardwareAcceleration();
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,UseChromeOSDirectVideoDecoder');
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection in main process', error);
});

function resolvePreloadPath(): string {
  const mjsPath = path.join(__dirname, '../preload/index.mjs');
  if (existsSync(mjsPath)) {
    return mjsPath;
  }

  return path.join(__dirname, '../preload/index.js');
}

function createMainWindow(): BrowserWindow {
  const parentBounds = BrowserWindow.getFocusedWindow()?.getBounds();
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    x: parentBounds ? parentBounds.x + 28 : undefined,
    y: parentBounds ? parentBounds.y + 28 : undefined,
    backgroundColor: '#10141b',
    title: 'SSH Studio',
    frame: true,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const sessionManager = new SshSessionManager();
  const webContentsId = window.webContents.id;
  const unsubscribeConnectionState = sessionManager.onConnectionState((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.connectionState, payload);
    }
  });
  const unsubscribeTerminalEvent = sessionManager.onTerminalEvent((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalEvent, payload);
    }
  });
  const unsubscribeTunnelEvent = sessionManager.onTunnelEvent((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.tunnelEvent, payload);
    }
  });
  const unsubscribeFileOperationEvent = sessionManager.onFileOperationEvent((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.fileOperationEvent, payload);
    }
  });
  const unsubscribeHostMetricsEvent = sessionManager.onHostMetricsEvent((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.hostMetricsEvent, payload);
    }
  });
  // Video frames/state are routed only to the dedicated observer window for that
  // stream (not broadcast to the owning main window), since the main window has
  // no use for raw frame data and forwarding it there would waste CPU/memory.
  const unsubscribeVideoFrameEvent = sessionManager.onVideoFrameEvent((payload) => {
    const observer = videoObserverWindows.get(payload.streamId);
    if (observer && !observer.isDestroyed()) {
      observer.webContents.send(IPC_CHANNELS.videoFrameEvent, payload);
    }
  });
  const unsubscribeVideoStreamStateEvent = sessionManager.onVideoStreamStateEvent((payload) => {
    const observer = videoObserverWindows.get(payload.streamId);
    if (observer && !observer.isDestroyed()) {
      observer.webContents.send(IPC_CHANNELS.videoStreamStateEvent, payload);
    }
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.videoStreamStateEvent, payload);
    }
  });
  const unsubscribeLanguageServerDiagnostics = sessionManager.onLanguageServerDiagnostics((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.languageServerDiagnosticsEvent, payload);
    }
  });
  const unsubscribeLanguageServerState = sessionManager.onLanguageServerState((payload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.languageServerStateEvent, payload);
    }
  });

  windowSessions.set(webContentsId, {
    window,
    sessionManager,
    unsubscribeConnectionState,
    unsubscribeTerminalEvent,
    unsubscribeTunnelEvent,
    unsubscribeFileOperationEvent,
    unsubscribeHostMetricsEvent,
    unsubscribeVideoFrameEvent,
    unsubscribeVideoStreamStateEvent,
    unsubscribeLanguageServerDiagnostics,
    unsubscribeLanguageServerState,
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  window.once('closed', () => {
    void disposeWindowSession(webContentsId);
  });

  return window;
}

async function disposeWindowSession(webContentsId: number): Promise<void> {
  const session = windowSessions.get(webContentsId);
  if (!session) {
    return;
  }

  windowSessions.delete(webContentsId);
  session.unsubscribeConnectionState();
  session.unsubscribeTerminalEvent();
  session.unsubscribeTunnelEvent();
  session.unsubscribeFileOperationEvent();
  session.unsubscribeHostMetricsEvent();
  session.unsubscribeVideoFrameEvent();
  session.unsubscribeVideoStreamStateEvent();
  session.unsubscribeLanguageServerDiagnostics();
  session.unsubscribeLanguageServerState();

  for (const [streamId, ownerId] of [...videoStreamOwners.entries()]) {
    if (ownerId !== webContentsId) {
      continue;
    }

    videoStreamOwners.delete(streamId);
    const observer = videoObserverWindows.get(streamId);
    videoObserverWindows.delete(streamId);
    if (observer && !observer.isDestroyed()) {
      observer.close();
    }
  }

  try {
    await session.sessionManager.disconnect();
  } catch {
    // Ignore shutdown errors while the window is already closing.
  }
}

function createVideoObserverWindow(streamId: string, ownerWebContentsId: number): BrowserWindow {
  const ownerSession = windowSessions.get(ownerWebContentsId);
  const ownerBounds = ownerSession?.window.getBounds();
  const observer = new BrowserWindow({
    width: 960,
    height: 620,
    minWidth: 260,
    minHeight: 180,
    x: ownerBounds ? ownerBounds.x + 36 : undefined,
    y: ownerBounds ? ownerBounds.y + 36 : undefined,
    backgroundColor: '#000000',
    title: '视觉观测 · Vision Observer',
    autoHideMenuBar: true,
    minimizable: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const hash = `#/video-observer/${encodeURIComponent(streamId)}`;
  if (process.env.ELECTRON_RENDERER_URL) {
    void observer.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash}`);
  } else {
    void observer.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  }

  videoObserverWindows.set(streamId, observer);
  videoStreamOwners.set(streamId, ownerWebContentsId);

  observer.once('closed', () => {
    videoObserverWindows.delete(streamId);
    videoStreamOwners.delete(streamId);
    const owner = windowSessions.get(ownerWebContentsId);
    if (owner) {
      void owner.sessionManager.stopVideoStream(streamId).catch(() => undefined);
    }
  });

  return observer;
}

function resizeVideoObserverWindow(streamId: string, senderId: number, width: number, height: number): void {
  const observer = videoObserverWindows.get(streamId);
  if (!observer || observer.isDestroyed() || observer.webContents.id !== senderId) {
    return;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }

  const { workArea } = screen.getDisplayMatching(observer.getBounds());
  observer.setContentSize(
    Math.min(Math.max(260, Math.round(width)), Math.max(260, workArea.width - 80)),
    Math.min(Math.max(180, Math.round(height)), Math.max(180, workArea.height - 80)),
  );
}

function getSessionManager(webContentsId: number): SshSessionManager {
  const session = windowSessions.get(webContentsId);
  if (!session) {
    throw new Error('No active window session');
  }

  return session.sessionManager;
}

function getSavedConnectionStore(): SavedConnectionStore {
  if (!savedConnectionStore) {
    throw new Error('Saved connection store is not ready');
  }

  return savedConnectionStore;
}

function getBrowserWindow(webContentsId: number): BrowserWindow {
  const session = windowSessions.get(webContentsId);
  if (!session) {
    throw new Error('No active window session');
  }

  return session.window;
}

function normalizeDownloadInput(input: DownloadRemoteEntryInput | string): DownloadRemoteEntryInput {
  if (typeof input === 'string') {
    return {
      operationId: `legacy-${Date.now()}`,
      remotePath: input,
      localPath: '',
      conflictStrategy: 'ask',
    };
  }

  return input;
}

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }

  ipcRegistered = true;

  ipcMain.handle(IPC_CHANNELS.openNewWindow, () => {
    createMainWindow();
  });
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: string) => {
    const nextUrl = new URL(url);
    if (!['http:', 'https:'].includes(nextUrl.protocol)) {
      throw new Error('Only http and https links are supported');
    }

    await shell.openExternal(nextUrl.toString());
  });
  ipcMain.handle(IPC_CHANNELS.connect, async (event, input: ConnectInput) => {
    const savedConnectionId = getSavedConnectionStore().getConnectionId(input);
    const result = await getSessionManager(event.sender.id).connect(input);
    await getSavedConnectionStore().saveConnection(input);

    return {
      ...result,
      savedConnectionId,
    };
  });
  ipcMain.handle(IPC_CHANNELS.connectSaved, async (event, savedConnectionId: string) => {
    const input = await getSavedConnectionStore().getConnectInput(savedConnectionId);
    const result = await getSessionManager(event.sender.id).connect(input);
    await getSavedConnectionStore().saveConnection(input);

    return {
      ...result,
      savedConnectionId,
    };
  });
  ipcMain.handle(IPC_CHANNELS.disconnect, (event) => getSessionManager(event.sender.id).disconnect());
  ipcMain.handle(IPC_CHANNELS.tailscaleHostsList, () => listTailscaleHosts());
  ipcMain.handle(IPC_CHANNELS.savedConnectionsList, () => getSavedConnectionStore().listSummaries());
  ipcMain.handle(IPC_CHANNELS.savedConnectionsRemove, (_event, savedConnectionId: string) =>
    getSavedConnectionStore().removeConnection(savedConnectionId),
  );
  ipcMain.handle(IPC_CHANNELS.savedConnectionsRename, (_event, savedConnectionId: string, displayName: string) =>
    getSavedConnectionStore().renameConnection(savedConnectionId, displayName),
  );
  ipcMain.handle(IPC_CHANNELS.savedConnectionsUpdateWorkspace, (_event, savedConnectionId: string, workspacePath: string) =>
    getSavedConnectionStore().updateWorkspacePath(savedConnectionId, workspacePath),
  );
  ipcMain.handle(IPC_CHANNELS.readDir, (event, remotePath: string) =>
    getSessionManager(event.sender.id).readDir(remotePath),
  );
  ipcMain.handle(IPC_CHANNELS.readFile, (event, remotePath: string) =>
    getSessionManager(event.sender.id).readFile(remotePath),
  );
  ipcMain.handle(IPC_CHANNELS.readBinaryFile, (event, input: ReadRemoteBinaryFileInput) =>
    getSessionManager(event.sender.id).readBinaryFile(input),
  );
  ipcMain.handle(IPC_CHANNELS.startAutomaticMediaCache, (event, remoteDirectory: string) => {
    const manager = getSessionManager(event.sender.id);
    manager.startAutomaticMediaCache(remoteDirectory);
    return manager.getIdleTransferSnapshot();
  });
  ipcMain.handle(IPC_CHANNELS.queueIdleDownload, async (event, input: QueueIdleDownloadInput) => {
    let localPath = input.localPath?.trim();
    if (!localPath) {
      const result = await dialog.showOpenDialog(getBrowserWindow(event.sender.id), {
        title: 'Choose folder for idle download',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      localPath = path.join(result.filePaths[0], path.posix.basename(input.remotePath));
    }
    return getSessionManager(event.sender.id).queueIdleDownload(input.remotePath, localPath);
  });
  ipcMain.handle(IPC_CHANNELS.idleTransferSnapshot, (event) =>
    getSessionManager(event.sender.id).getIdleTransferSnapshot(),
  );
  ipcMain.handle(IPC_CHANNELS.cancelIdleDownload, (event, remotePath: string) =>
    getSessionManager(event.sender.id).cancelIdleDownload(remotePath),
  );
  ipcMain.handle(IPC_CHANNELS.cancelIdleDownloadGroup, (event, groupPath: string) =>
    getSessionManager(event.sender.id).cancelIdleDownloadGroup(groupPath),
  );
  ipcMain.handle(IPC_CHANNELS.writeFileAtomic, (event, input: SaveRemoteFileInput) =>
    getSessionManager(event.sender.id).writeFileAtomic(input),
  );
  ipcMain.handle(IPC_CHANNELS.createEntry, (event, input: CreateRemoteEntryInput) =>
    getSessionManager(event.sender.id).createEntry(input),
  );
  ipcMain.handle(IPC_CHANNELS.renameEntry, (event, input: RenameRemoteEntryInput) =>
    getSessionManager(event.sender.id).renameEntry(input),
  );
  ipcMain.handle(IPC_CHANNELS.deleteEntry, (event, input: DeleteRemoteEntryInput) =>
    getSessionManager(event.sender.id).deleteEntry(input),
  );
  ipcMain.handle(IPC_CHANNELS.uploadLocalEntries, async (event, input: UploadLocalEntriesInput): Promise<FileOperationResult> => {
    return getSessionManager(event.sender.id).uploadLocalEntries(input);
  });
  ipcMain.handle(
    IPC_CHANNELS.downloadEntry,
    async (event, input: DownloadRemoteEntryInput | string): Promise<FileOperationResult> => {
      const normalizedInput = normalizeDownloadInput(input);
      if (normalizedInput.localPath.trim() === '') {
        const result = await dialog.showOpenDialog(getBrowserWindow(event.sender.id), {
          title: 'Choose download folder',
          defaultPath: app.getPath('downloads'),
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { status: 'completed', skippedItems: 0 };
        }
        normalizedInput.localPath = path.join(result.filePaths[0], path.basename(normalizedInput.remotePath));
      }
      return getSessionManager(event.sender.id).downloadEntry(normalizedInput);
    },
  );
  ipcMain.handle(IPC_CHANNELS.cancelFileOperation, (event, operationId: string) =>
    getSessionManager(event.sender.id).cancelFileOperation(operationId),
  );
  ipcMain.handle(IPC_CHANNELS.getTransferCapabilities, async (event): Promise<TransferCapabilities> => {
    const [localRsync, remoteRsync] = await Promise.all([
      detectLocalRsync(),
      getSessionManager(event.sender.id).probeRemoteRsync(),
    ]);
    return { localRsync, remoteRsync };
  });
  ipcMain.handle(IPC_CHANNELS.searchInFiles, (event, input: SearchRemoteFilesInput) =>
    getSessionManager(event.sender.id).searchInFiles(input),
  );
  ipcMain.handle(IPC_CHANNELS.pickPrivateKeyPath, async (event) => {
    const result = await dialog.showOpenDialog(getBrowserWindow(event.sender.id), {
      title: 'Select private key',
      properties: ['openFile'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.pickKnownHostsPath, async (event) => {
    const result = await dialog.showOpenDialog(getBrowserWindow(event.sender.id), {
      title: 'Select known_hosts file',
      properties: ['openFile'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.pickUploadEntries, async (event) => {
    const result = await dialog.showOpenDialog(getBrowserWindow(event.sender.id), {
      title: 'Select files or folders to upload',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle(IPC_CHANNELS.pickDownloadDirectory, async (event) => {
    const result = await dialog.showOpenDialog(getBrowserWindow(event.sender.id), {
      title: 'Choose download folder',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.terminalCreate, (event, input?: CreateTerminalInput) =>
    getSessionManager(event.sender.id).createTerminal(input),
  );
  ipcMain.handle(IPC_CHANNELS.terminalShellSupport, (event) =>
    getSessionManager(event.sender.id).getRemoteShellSupport(),
  );
  ipcMain.handle(IPC_CHANNELS.terminalKillSession, (event, sessionName: string) =>
    getSessionManager(event.sender.id).killRemoteShellSession(sessionName),
  );
  ipcMain.handle(IPC_CHANNELS.hostMetricsStart, (event, workspacePath: string, intervalMs?: number) =>
    getSessionManager(event.sender.id).startHostMetrics(workspacePath, intervalMs),
  );
  ipcMain.handle(IPC_CHANNELS.hostMetricsStop, (event) => {
    getSessionManager(event.sender.id).stopHostMetrics();
  });
  ipcMain.handle(IPC_CHANNELS.hostMetricsRefresh, (event, workspacePath: string) =>
    getSessionManager(event.sender.id).collectHostMetrics(workspacePath),
  );
  ipcMain.handle(IPC_CHANNELS.terminalWrite, (event, terminalId: string, data: string) =>
    getSessionManager(event.sender.id).writeTerminal(terminalId, data),
  );
  ipcMain.handle(IPC_CHANNELS.terminalResize, (event, terminalId: string, cols: number, rows: number) =>
    getSessionManager(event.sender.id).resizeTerminal(terminalId, cols, rows),
  );
  ipcMain.handle(IPC_CHANNELS.terminalClose, (event, terminalId: string) =>
    getSessionManager(event.sender.id).closeTerminal(terminalId),
  );
  ipcMain.handle(IPC_CHANNELS.tunnelsList, async (_event, savedConnectionId: string) => {
    const configs = await getSavedConnectionStore().getTunnels(savedConnectionId);
    return getSessionManager(_event.sender.id).listTunnelSnapshots(configs);
  });
  ipcMain.handle(IPC_CHANNELS.tunnelsSave, async (event, savedConnectionId: string, tunnel: SavedTunnelConfig) => {
    await getSessionManager(event.sender.id).stopTunnel(tunnel.id);
    await getSavedConnectionStore().saveTunnel(savedConnectionId, tunnel);
  });
  ipcMain.handle(IPC_CHANNELS.tunnelsRemove, async (event, savedConnectionId: string, tunnelId: string) => {
    await getSessionManager(event.sender.id).stopTunnel(tunnelId);
    await getSavedConnectionStore().removeTunnel(savedConnectionId, tunnelId);
  });
  ipcMain.handle(IPC_CHANNELS.tunnelsStart, async (event, savedConnectionId: string, tunnelId: string) => {
    const tunnel = await getSavedConnectionStore().getTunnel(savedConnectionId, tunnelId);
    await getSessionManager(event.sender.id).startTunnel(tunnel);
  });
  ipcMain.handle(IPC_CHANNELS.tunnelsStop, (event, tunnelId: string) =>
    getSessionManager(event.sender.id).stopTunnel(tunnelId),
  );
  ipcMain.handle(IPC_CHANNELS.visionModeEnable, (event, display?: string) =>
    getSessionManager(event.sender.id).enableVisionMode(display),
  );
  ipcMain.handle(IPC_CHANNELS.visionModeDisable, (event) => {
    getSessionManager(event.sender.id).disableVisionMode();
  });
  ipcMain.handle(IPC_CHANNELS.videoStreamStart, async (event, input: StartVideoStreamInput) => {
    const result = await getSessionManager(event.sender.id).startVideoStream(input);
    createVideoObserverWindow(result.streamId, event.sender.id);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.videoStreamStop, async (_event, streamId: string) => {
    const observer = videoObserverWindows.get(streamId);
    videoObserverWindows.delete(streamId);
    const ownerId = videoStreamOwners.get(streamId);
    videoStreamOwners.delete(streamId);
    if (observer && !observer.isDestroyed()) {
      observer.close();
    }
    if (ownerId !== undefined) {
      const owner = windowSessions.get(ownerId);
      if (owner) {
        await owner.sessionManager.stopVideoStream(streamId);
      }
    }
  });
  ipcMain.handle(IPC_CHANNELS.videoObserverResize, (event, streamId: string, width: number, height: number) => {
    resizeVideoObserverWindow(streamId, event.sender.id, width, height);
  });
  ipcMain.handle(IPC_CHANNELS.languageServerStart, (event, input: StartLanguageServerInput) =>
    getSessionManager(event.sender.id).startLanguageServer(input),
  );
  ipcMain.handle(IPC_CHANNELS.languageServerStop, (event, sessionId: string) =>
    getSessionManager(event.sender.id).stopLanguageServer(sessionId),
  );
  ipcMain.handle(IPC_CHANNELS.languageServerDocumentOpen, (event, input: LanguageServerDocumentInput) =>
    getSessionManager(event.sender.id).openLanguageDocument(input),
  );
  ipcMain.handle(IPC_CHANNELS.languageServerDocumentChange, (event, input: LanguageServerDocumentChangeInput) =>
    getSessionManager(event.sender.id).changeLanguageDocument(input),
  );
  ipcMain.handle(IPC_CHANNELS.languageServerDocumentSave, (event, input: LanguageServerDocumentReference) =>
    getSessionManager(event.sender.id).saveLanguageDocument(input),
  );
  ipcMain.handle(IPC_CHANNELS.languageServerDocumentClose, (event, input: LanguageServerDocumentReference) =>
    getSessionManager(event.sender.id).closeLanguageDocument(input),
  );
  ipcMain.handle(IPC_CHANNELS.languageServerFeature, (event, input: LanguageServerFeatureInput) =>
    getSessionManager(event.sender.id).requestLanguageFeature(input),
  );
}

app.whenReady().then(() => {
  savedConnectionStore = new SavedConnectionStore(app.getPath('userData'));
  registerIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
