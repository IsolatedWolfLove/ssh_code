import path from 'node:path';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';

import { app, BrowserWindow, ipcMain } from 'electron';

import { IPC_CHANNELS } from '../shared/contracts';
import type {
  ConnectInput,
  CreateRemoteEntryInput,
  RenameRemoteEntryInput,
  SaveRemoteFileInput,
} from '../shared/contracts';
import { SavedConnectionStore } from './saved-connections';
import { SshSessionManager } from './ssh-session';

interface WindowSession {
  window: BrowserWindow;
  sessionManager: SshSessionManager;
  unsubscribeConnectionState: () => void;
  unsubscribeTerminalEvent: () => void;
}

const windowSessions = new Map<number, WindowSession>();
let ipcRegistered = false;
let savedConnectionStore: SavedConnectionStore | null = null;

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

  windowSessions.set(webContentsId, {
    window,
    sessionManager,
    unsubscribeConnectionState,
    unsubscribeTerminalEvent,
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
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

  try {
    await session.sessionManager.disconnect();
  } catch {
    // Ignore shutdown errors while the window is already closing.
  }
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

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }

  ipcRegistered = true;

  ipcMain.handle(IPC_CHANNELS.openNewWindow, () => {
    createMainWindow();
  });
  ipcMain.handle(IPC_CHANNELS.connect, async (event, input: ConnectInput) => {
    const savedConnectionId = getSavedConnectionStore().getConnectionId(input);
    const result = await getSessionManager(event.sender.id).connect(input);

    void getSavedConnectionStore().saveConnection(input).catch((error) => {
      console.error('Unable to persist saved connection', error);
    });

    return {
      ...result,
      savedConnectionId,
    };
  });
  ipcMain.handle(IPC_CHANNELS.connectSaved, async (event, savedConnectionId: string) => {
    const input = await getSavedConnectionStore().getConnectInput(savedConnectionId);
    const result = await getSessionManager(event.sender.id).connect(input);

    void getSavedConnectionStore().saveConnection(input).catch((error) => {
      console.error('Unable to persist saved connection', error);
    });

    return {
      ...result,
      savedConnectionId,
    };
  });
  ipcMain.handle(IPC_CHANNELS.disconnect, (event) => getSessionManager(event.sender.id).disconnect());
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
  ipcMain.handle(IPC_CHANNELS.writeFileAtomic, (event, input: SaveRemoteFileInput) =>
    getSessionManager(event.sender.id).writeFileAtomic(input),
  );
  ipcMain.handle(IPC_CHANNELS.createEntry, (event, input: CreateRemoteEntryInput) =>
    getSessionManager(event.sender.id).createEntry(input),
  );
  ipcMain.handle(IPC_CHANNELS.renameEntry, (event, input: RenameRemoteEntryInput) =>
    getSessionManager(event.sender.id).renameEntry(input),
  );
  ipcMain.handle(IPC_CHANNELS.terminalCreate, (event) => getSessionManager(event.sender.id).createTerminal());
  ipcMain.handle(IPC_CHANNELS.terminalWrite, (event, terminalId: string, data: string) =>
    getSessionManager(event.sender.id).writeTerminal(terminalId, data),
  );
  ipcMain.handle(IPC_CHANNELS.terminalResize, (event, terminalId: string, cols: number, rows: number) =>
    getSessionManager(event.sender.id).resizeTerminal(terminalId, cols, rows),
  );
  ipcMain.handle(IPC_CHANNELS.terminalClose, (event, terminalId: string) =>
    getSessionManager(event.sender.id).closeTerminal(terminalId),
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
