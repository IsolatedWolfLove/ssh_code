import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Camera, Check, ChevronDown, CircleAlert, Copy, ExternalLink, FolderSearch, PlugZap, RefreshCw, Search, Download, Upload, Trash2, PencilLine, TerminalSquare, X } from 'lucide-react';
import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ConnectInput,
  ConnectResult,
  ConnectionStatePayload,
  ConnectionDiagnosticCode,
  DownloadRemoteEntryInput,
  FileConflictItem,
  FileConflictStrategy,
  FileOperationEvent,
  HostMetricsEvent,
  HostMetricsSnapshot,
  IdleTransferSnapshot,
  RemoteFileSystemState,
  RemoteDirectoryEntry,
  SavedConnectionSummary,
  SaveRemoteFileResult,
  SavedTunnelConfig,
  SearchRemoteFilesResult,
  TailscaleHostSummary,
  TunnelEvent,
  TunnelRuntimeState,
  TunnelSnapshot,
  UploadLocalEntriesInput,
} from '../../shared/contracts';
import { ConnectionForm } from './components/ConnectionForm';
import { EntryDialog } from './components/EntryDialog';
import { EditorTabs, type EditorTabItem } from './components/EditorTabs';
import { FileTree } from './components/FileTree';
import { FolderPickerDialog } from './components/FolderPickerDialog';
import { HostMetricsBar } from './components/HostMetricsBar';
import { ImagePreview, buildImageDataUrl, isImagePath } from './components/ImagePreview';
import { QuickCommandsDialog, type QuickCommandItem } from './components/QuickCommandsDialog';
import { SearchDialog } from './components/SearchDialog';
import { TerminalPanel, type TerminalPanelHandle } from './components/TerminalPanel';
import { TunnelsDialog } from './components/TunnelsDialog';
import { useRemoteLanguageServer } from './use-remote-language-server';

const RemoteEditor = lazy(() => import('./components/RemoteEditor'));

const DEFAULT_CONNECTION_FORM: ConnectInput = {
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  agentSocket: '',
  hostVerification: 'off',
  knownHostsPath: '',
  jumpHost: undefined,
};

const DEFAULT_CONNECTION_STATUS: ConnectionStatePayload = {
  state: 'disconnected',
  message: 'Disconnected',
  filesystemState: 'idle',
};

const QUICK_COMMANDS_STORAGE_KEY = 'ssh-studio.quick-commands.v1';
const HOST_METRICS_INTERVAL_MS = 4000;
// Long enough that a training job writing plots produces a new frame between
// reloads, short enough to feel live.
const IMAGE_AUTO_REFRESH_INTERVAL_MS = 3000;

type EntryDialogState =
  | {
      mode: 'create';
      entryKind: 'directory' | 'file';
      parentPath: string;
      value: string;
    }
  | {
      mode: 'rename';
      entry: RemoteDirectoryEntry;
      value: string;
    };

interface SavedConnectionRenameDialogState {
  savedConnectionId: string;
  value: string;
}

interface TreeContextMenuState {
  path: string;
  kind: 'directory' | 'file';
  x: number;
  y: number;
}

interface FileOperationItem {
  operationId: string;
  kind: FileOperationEvent['kind'];
  status: FileOperationEvent['status'];
  sourcePath: string;
  targetPath: string;
  message: string;
  completedItems: number;
  totalItems: number;
  skippedItems: number;
  currentPath?: string;
  error?: string;
  retryable?: boolean;
  transferredBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  transport?: FileOperationEvent['transport'];
}

interface FileConflictDialogState {
  kind: 'upload' | 'download';
  operationId: string;
  sourcePath: string;
  targetPath: string;
  localPaths?: string[];
  conflicts: FileConflictItem[];
}

interface ReconnectTarget {
  savedConnectionId: string;
  workspacePath?: string;
  previousConnectionId?: string | null;
}

interface TailscaleAuthDialogState {
  url: string;
  copied: boolean;
}

type RetryableFileRequest =
  | {
      kind: 'upload';
      request: UploadLocalEntriesInput;
    }
  | {
      kind: 'download';
      request: DownloadRemoteEntryInput;
    }
  | {
      kind: 'delete';
      request: { path: string; operationId: string };
    };

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function detectLanguage(remotePath: string): string {
  const extension = remotePath.split('.').pop()?.toLowerCase() ?? '';

  const byExtension: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };

  return byExtension[extension] ?? 'plaintext';
}

function buildTabId(connectionId: string, remotePath: string): string {
  return `${connectionId}:${remotePath}`;
}

function getParentPath(remotePath: string): string {
  return remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) || '/' : '/';
}

function getWorkspaceName(remotePath: string): string {
  return remotePath === '/' ? '/' : remotePath.split('/').filter(Boolean).pop() ?? remotePath;
}

function remapPathAfterRename(fromPath: string, toPath: string, currentPath: string): string | null {
  if (currentPath === fromPath) {
    return toPath;
  }

  const prefix = `${fromPath}/`;
  if (!currentPath.startsWith(prefix)) {
    return null;
  }

  return `${toPath}${currentPath.slice(fromPath.length)}`;
}

function mergeWorkspacePaths(existingPaths: string[], nextPath: string): string[] {
  const workspacePath = nextPath.trim();
  if (workspacePath === '') {
    return existingPaths;
  }

  return [workspacePath, ...existingPaths.filter((path) => path !== workspacePath)].slice(0, 6);
}

function createQuickCommandId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTunnelRunning(state: TunnelRuntimeState): boolean {
  return state.status === 'running' || state.status === 'starting';
}

function isQuickCommandItem(value: unknown): value is QuickCommandItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as QuickCommandItem).id === 'string' &&
    typeof (value as QuickCommandItem).name === 'string' &&
    typeof (value as QuickCommandItem).command === 'string'
  );
}

function loadQuickCommands(): QuickCommandItem[] {
  try {
    const raw = window.localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter(isQuickCommandItem).filter((item) => item.name.trim() !== '' && item.command.trim() !== '')
      : [];
  } catch {
    return [];
  }
}

function saveQuickCommands(commands: QuickCommandItem[]): void {
  try {
    window.localStorage.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
  } catch {
    // Keep command editing usable even if local storage is unavailable.
  }
}

function getFileSystemStatusText(filesystemState: RemoteFileSystemState | undefined): string {
  switch (filesystemState) {
    case 'loading':
      return 'Preparing files';
    case 'ready':
      return 'Files ready';
    case 'error':
      return 'Files unavailable';
    default:
      return 'Files idle';
  }
}

function getConnectionDiagnosticLabel(code: ConnectionDiagnosticCode | undefined): string | null {
  switch (code) {
    case 'wrongPassword':
      return 'Password incorrect';
    case 'hostUnreachable':
      return 'Host unreachable';
    case 'knownHosts':
      return 'Host key mismatch';
    case 'privateKey':
      return 'Private key issue';
    case 'authenticationFailed':
      return 'Authentication failed';
    default:
      return null;
  }
}

function getFileOperationLabel(kind: FileOperationItem['kind']): string {
  switch (kind) {
    case 'upload':
      return 'Upload';
    case 'download':
      return 'Download';
    default:
      return 'Delete';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function formatRate(bytesPerSecond: number | undefined): string | null {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    return `${minutes}m ${total % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function remapTabsToConnection(
  tabs: EditorTabItem[],
  previousConnectionId: string | null,
  nextConnectionId: string,
): EditorTabItem[] {
  if (!previousConnectionId) {
    return tabs;
  }

  return tabs.map((tab) =>
    tab.connectionId === previousConnectionId
      ? {
          ...tab,
          id: buildTabId(nextConnectionId, tab.path),
          connectionId: nextConnectionId,
        }
      : tab,
  );
}

function joinLocalPath(basePath: string, name: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/';
  const normalizedBase = basePath.replace(/[\\/]+$/, '');
  return `${normalizedBase}${separator}${name}`;
}

function useStableCallback<Args extends unknown[], Return>(
  callback: (...args: Args) => Return,
): (...args: Args) => Return {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

function EditorLoading({ spinning }: { spinning: boolean }) {
  return (
    <div className="editor-loading">
      <RefreshCw className={spinning ? 'spin' : ''} size={16} />
      <span>Loading editor</span>
    </div>
  );
}

export function App() {
  const [connectionForm, setConnectionForm] = useState<ConnectInput>(DEFAULT_CONNECTION_FORM);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatePayload>(DEFAULT_CONNECTION_STATUS);
  const [currentConnectionId, setCurrentConnectionId] = useState<string | null>(null);
  const [currentSavedConnectionId, setCurrentSavedConnectionId] = useState<string | null>(null);
  const [showConnectionScreen, setShowConnectionScreen] = useState(true);
  const [savedConnections, setSavedConnections] = useState<SavedConnectionSummary[]>([]);
  const [tailscaleHosts, setTailscaleHosts] = useState<TailscaleHostSummary[]>([]);
  const [isLoadingTailscaleHosts, setIsLoadingTailscaleHosts] = useState(true);
  const [isLoadingSavedConnections, setIsLoadingSavedConnections] = useState(true);
  const [activeSavedConnectionId, setActiveSavedConnectionId] = useState<string | null>(null);
  const [removingSavedConnectionId, setRemovingSavedConnectionId] = useState<string | null>(null);
  const [isImportingSshConfig, setIsImportingSshConfig] = useState(false);
  const [rootPath, setRootPath] = useState('/');
  const [workspacePath, setWorkspacePath] = useState('/');
  const [entriesByDirectory, setEntriesByDirectory] = useState<Record<string, RemoteDirectoryEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<EditorTabItem[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'connecting' | 'disconnecting' | null>(null);
  const [statusMessage, setStatusMessage] = useState('Disconnected');
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [entryDialog, setEntryDialog] = useState<EntryDialogState | null>(null);
  const [entryDialogBusy, setEntryDialogBusy] = useState(false);
  const [folderPickerInitialPath, setFolderPickerInitialPath] = useState<string | null>(null);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const [savedConnectionRenameDialog, setSavedConnectionRenameDialog] =
    useState<SavedConnectionRenameDialogState | null>(null);
  const [savedConnectionRenameBusy, setSavedConnectionRenameBusy] = useState(false);
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState | null>(null);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchRemoteFilesResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [quickCommandsDialogOpen, setQuickCommandsDialogOpen] = useState(false);
  const [quickCommands, setQuickCommands] = useState<QuickCommandItem[]>(() => loadQuickCommands());
  const [tunnelsDialogOpen, setTunnelsDialogOpen] = useState(false);
  const [tunnelSnapshots, setTunnelSnapshots] = useState<TunnelSnapshot[]>([]);
  const [tunnelDialogLoading, setTunnelDialogLoading] = useState(false);
  const [tunnelSaveBusy, setTunnelSaveBusy] = useState(false);
  const [busyTunnelIds, setBusyTunnelIds] = useState<Set<string>>(new Set());
  const [fileOperations, setFileOperations] = useState<FileOperationItem[]>([]);
  const [downloadQueueOpen, setDownloadQueueOpen] = useState(false);
  const [idleTransferSnapshot, setIdleTransferSnapshot] = useState<IdleTransferSnapshot | null>(null);
  const [conflictDialog, setConflictDialog] = useState<FileConflictDialogState | null>(null);
  const [reconnectTarget, setReconnectTarget] = useState<ReconnectTarget | null>(null);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [tailscaleAuthDialog, setTailscaleAuthDialog] = useState<TailscaleAuthDialogState | null>(null);
  const [editorRevealTarget, setEditorRevealTarget] = useState<{ tabId: string; line: number; column: number } | null>(null);
  const [hostMetrics, setHostMetrics] = useState<HostMetricsSnapshot | null>(null);
  const [hostMetricsError, setHostMetricsError] = useState<string | null>(null);
  const [imageAutoRefresh, setImageAutoRefresh] = useState(false);
  const [reloadingImagePath, setReloadingImagePath] = useState<string | null>(null);
  const [visionModeActive, setVisionModeActive] = useState(false);
  const [visionModeBusy, setVisionModeBusy] = useState(false);
  const [visionStreamId, setVisionStreamId] = useState<string | null>(null);
  const autoSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const directoryLoadPromisesRef = useRef(new Map<string, Promise<boolean>>());
  const idlePrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkspacePathRef = useRef<string | null>(null);
  const disconnectingManuallyRef = useRef(false);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null);
  const treeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const retryRequestsRef = useRef(new Map<string, RetryableFileRequest>());

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const languageServerState = useRemoteLanguageServer({
    connectionId: currentConnectionId,
    connected: connectionStatus.state === 'connected',
    workspacePath,
    tabs,
    onOpenLocation: async (remotePath, line, column) => {
      await openFile(remotePath, { line, column });
    },
  });
  const groupedSearchResults = useMemo(() => {
    const grouped = new Map<string, SearchRemoteFilesResult['matches']>();
    for (const match of searchResults?.matches ?? []) {
      const items = grouped.get(match.path);
      if (items) {
        items.push(match);
      } else {
        grouped.set(match.path, [match]);
      }
    }
    return [...grouped.entries()];
  }, [searchResults]);
  const workspaceName = getWorkspaceName(workspacePath);
  const selectedEntry = useMemo(
    () => {
      if (selectedTreePath === workspacePath) {
        return {
          name: workspaceName,
          path: workspacePath,
          kind: 'directory' as const,
        };
      }

      return (
        Object.values(entriesByDirectory)
          .flat()
          .find((entry) => entry.path === selectedTreePath) ?? null
      );
    },
    [entriesByDirectory, selectedTreePath, workspaceName, workspacePath],
  );
  const activeTunnelCount = useMemo(
    () => tunnelSnapshots.filter((snapshot) => isTunnelRunning(snapshot.state)).length,
    [tunnelSnapshots],
  );
  const visibleFileOperations = useMemo(() => {
    const nonDownloads = fileOperations.filter((operation) => operation.kind !== 'download');
    const running = nonDownloads.filter((operation) => operation.status === 'running');
    return running.length > 0 ? running : nonDownloads.slice(-1);
  }, [fileOperations]);
  const downloadQueue = useMemo(() => {
    const downloads = fileOperations.filter((operation) => operation.kind === 'download');
    const running = downloads.filter((operation) => operation.status === 'running');
    const operations = running.length > 0 ? running : downloads.slice(-1);
    const totalItems = operations.reduce((total, operation) => total + operation.totalItems, 0);
    const completedItems = operations.reduce(
      (total, operation) => total + operation.completedItems + operation.skippedItems,
      0,
    );
    const totalBytes = operations.reduce((total, operation) => total + (operation.totalBytes ?? 0), 0);
    const transferredBytes = operations.reduce((total, operation) => total + (operation.transferredBytes ?? 0), 0);
    const bytesPerSecond = operations.reduce((total, operation) => total + (operation.bytesPerSecond ?? 0), 0);
    const etaSeconds =
      bytesPerSecond > 0 && totalBytes > transferredBytes ? (totalBytes - transferredBytes) / bytesPerSecond : undefined;

    return {
      operations,
      status: running.length > 0 ? 'running' : operations[0]?.status,
      completedItems,
      totalItems,
      totalBytes,
      transferredBytes,
      bytesPerSecond,
      etaSeconds,
    };
  }, [fileOperations]);
  const saveActiveTab = useStableCallback(() => {
    if (!activeTabId) {
      return;
    }

    void saveTab(activeTabId);
  });

  useEffect(() => {
    const unsubscribe = window.electronAPI.onConnectionState((payload: ConnectionStatePayload) => {
      setConnectionStatus(payload);
      setStatusMessage(payload.message);

      if (payload.authUrl) {
        const authUrl = payload.authUrl;
        setTailscaleAuthDialog((previous) =>
          previous?.url === authUrl
            ? previous
            : {
                url: authUrl,
                copied: false,
              },
        );
      } else {
        setTailscaleAuthDialog(null);
      }

      if (payload.state === 'connected') {
        setCurrentConnectionId(payload.connectionId ?? null);
        setShowConnectionScreen(false);
        setReconnectBusy(false);
        disconnectingManuallyRef.current = false;
      }

      if (payload.state === 'disconnected') {
        setCurrentConnectionId(null);
        setReconnectBusy(false);
        if (!disconnectingManuallyRef.current && currentSavedConnectionId) {
          setReconnectTarget({
            savedConnectionId: currentSavedConnectionId,
            workspacePath,
            previousConnectionId: payload.connectionId ?? currentConnectionId,
          });
          setShowConnectionScreen(false);
        } else {
          setCurrentSavedConnectionId(null);
          setShowConnectionScreen(true);
          setEntryDialog(null);
          setFolderPickerInitialPath(null);
          setSavedConnectionRenameDialog(null);
          setSearchDialogOpen(false);
          setQuickCommandsDialogOpen(false);
          setTunnelsDialogOpen(false);
          setTunnelSnapshots([]);
          setBusyTunnelIds(new Set());
          setTunnelDialogLoading(false);
          setTunnelSaveBusy(false);
          setReconnectTarget(null);
        }
        disconnectingManuallyRef.current = false;
      }

      if (payload.state === 'error' && currentSavedConnectionId) {
        setReconnectTarget({
          savedConnectionId: currentSavedConnectionId,
          workspacePath,
          previousConnectionId: payload.connectionId ?? currentConnectionId,
        });
      }
    });

    return unsubscribe;
  }, [currentConnectionId, currentSavedConnectionId, workspacePath]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onTunnelEvent((event: TunnelEvent) => {
      setTunnelSnapshots((previous) =>
        previous.map((snapshot) =>
          snapshot.config.id === event.state.id
            ? {
                ...snapshot,
                state: event.state,
              }
            : snapshot,
        ),
      );

      if (event.state.message) {
        setStatusMessage(event.state.message);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onFileOperationEvent((event: FileOperationEvent) => {
      setFileOperations((previous) => {
        const index = previous.findIndex((item) => item.operationId === event.operationId);
        if (index === -1) {
          return [...previous, event].slice(-6);
        }

        const next = [...previous];
        next[index] = event;
        return next;
      });
      // Byte-progress events can arrive many times per second and from several
      // transfers at once. Keeping them out of the shared status text avoids
      // a layout/content race; each operation renders its own progress below.
      if (event.status !== 'running') {
        setStatusMessage(event.error ? event.error : event.message);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (connectionStatus.state !== 'connected') {
      setIdleTransferSnapshot(null);
      return;
    }

    let disposed = false;
    const refresh = () => {
      void window.electronAPI
        .getIdleTransferSnapshot()
        .then((snapshot) => {
          if (!disposed) {
            setIdleTransferSnapshot(snapshot);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [connectionStatus.state]);

  useEffect(() => {
    if (connectionStatus.state !== 'connected' || connectionStatus.filesystemState !== 'ready') {
      return;
    }

    const pendingWorkspacePath = pendingWorkspacePathRef.current;
    if (!pendingWorkspacePath) {
      return;
    }

    pendingWorkspacePathRef.current = null;
    void initializeRemoteState(
      {
        connectionId: connectionStatus.connectionId ?? currentConnectionId ?? '',
        homeDir: connectionStatus.homeDir,
        filesystemState: 'ready',
      },
      pendingWorkspacePath,
    );
  }, [connectionStatus, currentConnectionId]);

  useEffect(() => {
    void loadSavedConnections(true);
    void loadTailscaleHosts(true);
  }, []);

  useEffect(() => {
    if (!tunnelsDialogOpen || !currentSavedConnectionId) {
      return;
    }

    void loadTunnelSnapshots(currentSavedConnectionId);
  }, [currentSavedConnectionId, tunnelsDialogOpen]);

  useEffect(() => {
    if (connectionStatus.state !== 'connected' || !currentSavedConnectionId || workspacePath.trim() === '') {
      return;
    }

    const nextWorkspacePath = workspacePath;

    setSavedConnections((previous) =>
      previous.map((entry) =>
        entry.id === currentSavedConnectionId
          ? (() => {
              const workspacePaths = mergeWorkspacePaths(entry.workspacePaths, nextWorkspacePath);
              return {
                ...entry,
                workspacePaths,
                lastWorkspacePath: workspacePaths[0],
              };
            })()
          : entry,
      ),
    );

    void window.electronAPI.updateSavedConnectionWorkspace(currentSavedConnectionId, nextWorkspacePath).catch(() => {
      // Keep workspace persistence best-effort so navigation stays responsive.
    });
  }, [connectionStatus.state, currentSavedConnectionId, workspacePath]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        saveActiveTab();
        return;
      }

      if (event.shiftKey && key === 'f' && !showConnectionScreen) {
        event.preventDefault();
        setSearchDialogOpen(true);
        return;
      }

      if (event.shiftKey && key === 'p' && !showConnectionScreen) {
        event.preventDefault();
        setQuickCommandsDialogOpen(true);
        return;
      }

      if (event.shiftKey && key === 't' && !showConnectionScreen) {
        event.preventDefault();
        openTunnelsDialog();
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [connectionStatus.state, currentSavedConnectionId, saveActiveTab, showConnectionScreen]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onHostMetrics((event: HostMetricsEvent) => {
      // Snapshots from a previous connection would otherwise linger after a
      // reconnect and describe the wrong host.
      if (currentConnectionId && event.connectionId !== currentConnectionId) {
        return;
      }

      if (event.snapshot) {
        setHostMetrics(event.snapshot);
        setHostMetricsError(null);
        return;
      }

      setHostMetricsError(event.error ?? 'Unable to collect host metrics');
    });

    return unsubscribe;
  }, [currentConnectionId]);

  useEffect(() => {
    if (connectionStatus.state !== 'connected') {
      setHostMetrics(null);
      setHostMetricsError(null);
      return;
    }

    void window.electronAPI.startHostMetrics(workspacePath, HOST_METRICS_INTERVAL_MS).catch(() => {
      // A failed start just leaves the strip in its unavailable state.
    });

    return () => {
      void window.electronAPI.stopHostMetrics().catch(() => undefined);
    };
  }, [connectionStatus.state, currentConnectionId, workspacePath]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent): void {
      if (!fileMenuRef.current?.contains(event.target as Node)) {
        setFileMenuOpen(false);
      }

      if (treeContextMenu && !treeContextMenuRef.current?.contains(event.target as Node)) {
        setTreeContextMenu(null);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [treeContextMenu]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(autoSaveTimersRef.current)) {
        clearTimeout(timer);
      }
      if (idlePrefetchTimerRef.current) {
        clearTimeout(idlePrefetchTimerRef.current);
      }
    };
  }, []);

  // Only the visible image tab is polled: a training run can be writing dozens of
  // plots, and refreshing hidden tabs would transfer them all for nothing.
  useEffect(() => {
    if (!imageAutoRefresh || !activeTabId || activeTab?.kind !== 'image') {
      return;
    }

    const tabId = activeTabId;
    const timer = setInterval(() => {
      void reloadImageTab(tabId);
    }, IMAGE_AUTO_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [activeTab?.kind, activeTabId, imageAutoRefresh, tabs, currentConnectionId]);

  useEffect(() => {
    if (!editorRevealTarget || activeTab?.id !== editorRevealTarget.tabId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      setEditorRevealTarget(null);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeTab?.id, editorRevealTarget]);

  useEffect(() => {
    for (const tab of tabs) {
      const dirty = tab.content !== tab.savedContent;

      if (!autoSaveEnabled || !dirty || tab.isSaving || tab.connectionId !== currentConnectionId) {
        clearAutoSaveTimer(tab.id);
        continue;
      }

      if (autoSaveTimersRef.current[tab.id]) {
        continue;
      }

      autoSaveTimersRef.current[tab.id] = setTimeout(() => {
        delete autoSaveTimersRef.current[tab.id];
        void saveTab(tab.id, tab.autosaveRevision);
      }, 900);
    }

    for (const tabId of Object.keys(autoSaveTimersRef.current)) {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || !autoSaveEnabled || tab.content === tab.savedContent || tab.isSaving || tab.connectionId !== currentConnectionId) {
        clearAutoSaveTimer(tabId);
      }
    }
  }, [tabs, autoSaveEnabled, currentConnectionId]);

  async function connect(override?: ConnectInput): Promise<void> {
    const nextForm = override ?? connectionForm;
    const previousConnectionId = reconnectTarget?.previousConnectionId ?? currentConnectionId;
    const previousActiveTab = activeTab;
    setBusyAction('connecting');
    setActiveSavedConnectionId(null);
    setStatusMessage(`Connecting to ${nextForm.host}:${nextForm.port}...`);

    let matchingSavedConnection: SavedConnectionSummary | null = null;
    try {
      matchingSavedConnection = findMatchingSavedConnection(nextForm);
      const result = await window.electronAPI.connect(nextForm);
      const nextSavedConnectionId = result.savedConnectionId ?? matchingSavedConnection?.id ?? null;
      setCurrentSavedConnectionId(nextSavedConnectionId);
      setConnectionForm((previous) => ({ ...previous, password: '', passphrase: '' }));
      setTabs((previous) => remapTabsToConnection(previous, previousConnectionId, result.connectionId));
      if (previousConnectionId && previousActiveTab) {
        setActiveTabId(buildTabId(result.connectionId, previousActiveTab.path));
      }
      if (nextSavedConnectionId) {
        setReconnectTarget({
          savedConnectionId: nextSavedConnectionId,
          workspacePath: matchingSavedConnection?.workspacePaths[0] ?? matchingSavedConnection?.lastWorkspacePath,
          previousConnectionId: result.connectionId,
        });
      }
      void initializeRemoteState(result, matchingSavedConnection?.workspacePaths[0] ?? matchingSavedConnection?.lastWorkspacePath);
      void loadSavedConnections(true);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to connect'));
    } finally {
      setBusyAction(null);
    }
  }

  async function connectSaved(savedConnection: SavedConnectionSummary, preferredWorkspacePath?: string): Promise<void> {
    const previousConnectionId = reconnectTarget?.previousConnectionId ?? currentConnectionId;
    const previousActiveTab = activeTab;
    setBusyAction('connecting');
    setActiveSavedConnectionId(savedConnection.id);
    setStatusMessage(`Connecting to ${savedConnection.username}@${savedConnection.host}:${savedConnection.port}...`);

    try {
      const result = await window.electronAPI.connectSaved(savedConnection.id);
      setCurrentSavedConnectionId(result.savedConnectionId ?? savedConnection.id);
      setReconnectTarget({
        savedConnectionId: result.savedConnectionId ?? savedConnection.id,
        workspacePath: preferredWorkspacePath ?? savedConnection.workspacePaths[0] ?? savedConnection.lastWorkspacePath,
        previousConnectionId: result.connectionId,
      });
      setTabs((previous) => remapTabsToConnection(previous, previousConnectionId, result.connectionId));
      if (previousConnectionId && previousActiveTab) {
        setActiveTabId(buildTabId(result.connectionId, previousActiveTab.path));
      }
      void initializeRemoteState(
        result,
        preferredWorkspacePath ?? savedConnection.workspacePaths[0] ?? savedConnection.lastWorkspacePath,
      );
      void loadSavedConnections(true);
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to connect');
      if (/private key|passphrase/i.test(message)) {
    try {
          const savedInput = await window.electronAPI.getSavedConnectionInput(savedConnection.id);
          const passphrase = window.prompt('Enter SSH private key passphrase (leave blank if none):', '');
          if (passphrase !== null) {
            setConnectionForm({ ...savedInput, passphrase });
            setStatusMessage('Passphrase filled in. Press Connect to retry.');
          } else setStatusMessage(message);
        } catch { setStatusMessage(message); }
      } else setStatusMessage(message);
    } finally {
      setBusyAction(null);
      setActiveSavedConnectionId(null);
    }
  }

  async function disconnect(): Promise<void> {
    disconnectingManuallyRef.current = true;
    setBusyAction('disconnecting');
    clearAllAutoSaveTimers();
    setFileMenuOpen(false);
    setEntryDialog(null);
    setFolderPickerInitialPath(null);
    setSearchDialogOpen(false);
    setQuickCommandsDialogOpen(false);

    try {
      await window.electronAPI.disconnect();
      setEntriesByDirectory({});
      setExpandedDirectories(new Set());
      setVisionModeActive(false);
      setVisionStreamId(null);
    } catch (error) {
      disconnectingManuallyRef.current = false;
      setStatusMessage(getErrorMessage(error, 'Unable to disconnect'));
    } finally {
      setBusyAction(null);
    }
  }

  async function initializeRemoteState(
    result: ConnectResult,
    preferredWorkspacePath?: string,
  ): Promise<void> {
    const resolvedHomeDir = result.homeDir?.trim() || connectionStatus.homeDir?.trim();
    if (!resolvedHomeDir) {
      pendingWorkspacePathRef.current = preferredWorkspacePath?.trim() || null;
      return;
    }

    const nextWorkspacePath = preferredWorkspacePath?.trim() || resolvedHomeDir;

    if (result.filesystemState !== 'ready') {
      pendingWorkspacePathRef.current = nextWorkspacePath;
      setStatusMessage('Connected. Preparing remote files...');
      return;
    }

    setRootPath(resolvedHomeDir);
    setWorkspacePath(nextWorkspacePath);
    setSelectedTreePath(nextWorkspacePath);
    setEntriesByDirectory({});
    setExpandedDirectories(new Set([nextWorkspacePath]));
    void window.electronAPI.startAutomaticMediaCache(nextWorkspacePath).catch(() => {
      // Preview warming is opportunistic and must never block opening a workspace.
    });

    const loaded = await refreshDirectory(nextWorkspacePath, true);
    if (loaded || nextWorkspacePath === resolvedHomeDir) {
      return;
    }

    setWorkspacePath(resolvedHomeDir);
    setSelectedTreePath(resolvedHomeDir);
    setExpandedDirectories(new Set([resolvedHomeDir]));
    void window.electronAPI.startAutomaticMediaCache(resolvedHomeDir).catch(() => undefined);
    await refreshDirectory(resolvedHomeDir, true);
  }

  async function loadSavedConnections(silent = false): Promise<void> {
    setIsLoadingSavedConnections(true);

    try {
      const nextSavedConnections = await window.electronAPI.listSavedConnections();
      setSavedConnections(nextSavedConnections);
    } catch (error) {
      if (!silent) {
        setStatusMessage(getErrorMessage(error, 'Unable to load recent clients'));
      }
    } finally {
      setIsLoadingSavedConnections(false);
    }
  }

  async function loadTailscaleHosts(silent = false): Promise<void> {
    setIsLoadingTailscaleHosts(true);

    try {
      const nextHosts = await window.electronAPI.listTailscaleHosts();
      setTailscaleHosts(nextHosts);
    } catch (error) {
      if (!silent) {
        setStatusMessage(getErrorMessage(error, 'Unable to load Tailscale hosts'));
      }
    } finally {
      setIsLoadingTailscaleHosts(false);
    }
  }

  async function removeSavedConnection(savedConnectionId: string): Promise<void> {
    setRemovingSavedConnectionId(savedConnectionId);

    try {
      await window.electronAPI.removeSavedConnection(savedConnectionId);
      setSavedConnections((previous) => previous.filter((entry) => entry.id !== savedConnectionId));
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to remove saved client'));
    } finally {
      setRemovingSavedConnectionId(null);
    }
  }

  async function importSshConfig(): Promise<void> {
    setIsImportingSshConfig(true);
    try {
      const result = await window.electronAPI.importSshConfig();
      await loadSavedConnections(true);
      setStatusMessage(result.imported > 0 ? `Imported ${result.imported} SSH host${result.imported === 1 ? '' : 's'}` : `No new SSH hosts found in ${result.sourcePath}`);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to import SSH config'));
    } finally {
      setIsImportingSshConfig(false);
    }
  }

  function openRenameSavedConnectionDialog(savedConnectionId: string): void {
    const savedConnection = savedConnections.find((entry) => entry.id === savedConnectionId);
    if (!savedConnection) {
      return;
    }

    setSavedConnectionRenameDialog({
      savedConnectionId,
      value: savedConnection.displayName,
    });
  }

  function closeSavedConnectionRenameDialog(): void {
    if (savedConnectionRenameBusy) {
      return;
    }

    setSavedConnectionRenameDialog(null);
  }

  async function submitSavedConnectionRenameDialog(): Promise<void> {
    if (!savedConnectionRenameDialog) {
      return;
    }

    const nextDisplayName = savedConnectionRenameDialog.value.trim();
    if (nextDisplayName === '') {
      return;
    }

    setSavedConnectionRenameBusy(true);

    try {
      await window.electronAPI.renameSavedConnection(
        savedConnectionRenameDialog.savedConnectionId,
        nextDisplayName,
      );
      setSavedConnections((previous) =>
        previous.map((entry) =>
          entry.id === savedConnectionRenameDialog.savedConnectionId
            ? {
                ...entry,
                displayName: nextDisplayName,
              }
            : entry,
        ),
      );
      setSavedConnectionRenameDialog(null);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to rename saved connection'));
    } finally {
      setSavedConnectionRenameBusy(false);
    }
  }

  function clearAutoSaveTimer(tabId: string): void {
    const timer = autoSaveTimersRef.current[tabId];
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    delete autoSaveTimersRef.current[tabId];
  }

  function clearAllAutoSaveTimers(): void {
    for (const tabId of Object.keys(autoSaveTimersRef.current)) {
      clearAutoSaveTimer(tabId);
    }
  }

  async function refreshDirectory(remotePath: string, forceExpand = false): Promise<boolean> {
    const existingTask = directoryLoadPromisesRef.current.get(remotePath);
    if (existingTask) {
      return existingTask;
    }

    const task = (async () => {
      setLoadingDirectories((previous) => {
        const next = new Set(previous);
        next.add(remotePath);
        return next;
      });

    try {
        const entries = await window.electronAPI.readDir(remotePath);
        startTransition(() => {
          setEntriesByDirectory((previous) => ({
            ...previous,
            [remotePath]: entries,
          }));

          if (forceExpand) {
            setExpandedDirectories((previous) => {
              const next = new Set(previous);
              next.add(remotePath);
              return next;
            });
          }
        });
        return true;
      } catch (error) {
        setStatusMessage(getErrorMessage(error, `Unable to read ${remotePath}`));
        return false;
      } finally {
        directoryLoadPromisesRef.current.delete(remotePath);
        setLoadingDirectories((previous) => {
          const next = new Set(previous);
          next.delete(remotePath);
          return next;
        });
      }
    })();

    directoryLoadPromisesRef.current.set(remotePath, task);
    return task;
  }

  function findMatchingSavedConnection(input: Pick<ConnectInput, 'host' | 'port' | 'username'>): SavedConnectionSummary | null {
    const host = input.host.trim();
    const username = input.username.trim();

    return (
      savedConnections.find(
        (entry) => entry.host === host && entry.port === input.port && entry.username === username,
      ) ?? null
    );
  }

  function buildTailscaleForm(host: TailscaleHostSummary): ConnectInput {
    return {
      ...connectionForm,
      host: host.host,
      port: 22,
      username: host.sshUser?.trim() || connectionForm.username.trim() || 'root',
      authMethod: 'tailscale',
      hostVerification: 'off',
      password: '',
      privateKeyPath: '',
      passphrase: '',
      agentSocket: '',
      jumpHost: undefined,
    };
  }

  function applyTailscaleHost(host: TailscaleHostSummary): ConnectInput {
    const nextForm = buildTailscaleForm(host);
    setConnectionForm(nextForm);
    return nextForm;
  }

  async function toggleDirectory(remotePath: string): Promise<void> {
    setSelectedTreePath(remotePath);
    const expanded = expandedDirectories.has(remotePath);
    if (expanded) {
      setExpandedDirectories((previous) => {
        const next = new Set(previous);
        next.delete(remotePath);
        return next;
      });
      return;
    }

    setExpandedDirectories((previous) => {
      const next = new Set(previous);
      next.add(remotePath);
      return next;
    });

    if (!entriesByDirectory[remotePath]) {
      await refreshDirectory(remotePath);
    }
  }

  async function buildTextTab(connectionId: string, remotePath: string): Promise<EditorTabItem> {
    const file = await window.electronAPI.readFile(remotePath);

    return {
      id: buildTabId(connectionId, remotePath),
      connectionId,
      path: file.path,
      name: remotePath.split('/').pop() || remotePath,
      content: file.content,
      savedContent: file.content,
      isSaving: false,
      autosaveRevision: 0,
      kind: 'text',
    };
  }

  /**
   * Images are read as raw bytes and shown in a preview tab. Their `content` is
   * left empty so the dirty/save paths treat them as clean and read-only.
   */
  async function buildImageTab(connectionId: string, remotePath: string): Promise<EditorTabItem> {
    const file = await window.electronAPI.readBinaryFile({ path: remotePath });

    return {
      id: buildTabId(connectionId, remotePath),
      connectionId,
      path: file.path,
      name: remotePath.split('/').pop() || remotePath,
      content: '',
      savedContent: '',
      isSaving: false,
      autosaveRevision: 0,
      kind: 'image',
      imageDataUrl: buildImageDataUrl(file.path, file.base64),
      byteLength: file.byteLength,
      modifiedAt: file.modifiedAt,
    };
  }

  async function reloadImageTab(tabId: string): Promise<void> {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== 'image' || tab.connectionId !== currentConnectionId) {
      return;
    }

    setReloadingImagePath(tab.path);
    try {
      const file = await window.electronAPI.readBinaryFile({ path: tab.path });
      const nextDataUrl = buildImageDataUrl(file.path, file.base64);

      setTabs((previous) =>
        previous.map((item) =>
          item.id === tabId
            ? {
                ...item,
                imageDataUrl: nextDataUrl,
                byteLength: file.byteLength,
                modifiedAt: file.modifiedAt,
              }
            : item,
        ),
      );
    } catch (error) {
      setStatusMessage(getErrorMessage(error, `Unable to reload ${tab.path}`));
    } finally {
      setReloadingImagePath(null);
    }
  }

  async function openFile(remotePath: string, revealTarget?: { line: number; column: number }): Promise<void> {
    setSelectedTreePath(remotePath);
    if (!currentConnectionId) {
      setStatusMessage('Connect before opening files');
      return;
    }

    const existingTab = tabs.find(
      (tab) => tab.path === remotePath && tab.connectionId === currentConnectionId,
    );

    if (existingTab) {
      setActiveTabId(existingTab.id);
      if (revealTarget) {
        setEditorRevealTarget({
          tabId: existingTab.id,
          line: revealTarget.line,
          column: revealTarget.column,
        });
      }
      return;
    }

    setIsLoadingFile(true);
    setStatusMessage(`Opening ${remotePath}`);

    try {
      const nextTab = isImagePath(remotePath)
        ? await buildImageTab(currentConnectionId, remotePath)
        : await buildTextTab(currentConnectionId, remotePath);

      setTabs((previous) => [...previous, nextTab]);
      setActiveTabId(nextTab.id);
      if (revealTarget) {
        setEditorRevealTarget({
          tabId: nextTab.id,
          line: revealTarget.line,
          column: revealTarget.column,
        });
      }
      setStatusMessage(`Opened ${remotePath}`);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, `Unable to open ${remotePath}`));
    } finally {
      setIsLoadingFile(false);
    }
  }

  function closeTab(tabId: string): void {
    clearAutoSaveTimer(tabId);
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === tabId);
      if (index === -1) {
        return previous;
      }

      const nextTabs = previous.filter((tab) => tab.id !== tabId);

      if (activeTabId === tabId) {
        const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? null;
        setActiveTabId(fallback?.id ?? null);
      }

      return nextTabs;
    });
  }

  function updateActiveTabContent(nextContent: string | undefined): void {
    if (nextContent === undefined || !activeTabId) {
      return;
    }

    clearAutoSaveTimer(activeTabId);
    setTabs((previous) =>
      previous.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              content: nextContent,
              autosaveRevision: tab.autosaveRevision + 1,
            }
          : tab,
      ),
    );
  }

  async function saveTab(tabId: string, expectedRevision?: number): Promise<void> {
    clearAutoSaveTimer(tabId);
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) {
      return;
    }

    if (tab.connectionId !== currentConnectionId || !currentConnectionId) {
      setStatusMessage('This tab belongs to a previous session. Reopen it from the file tree.');
      return;
    }

    if (tab.content === tab.savedContent) {
      return;
    }

    if (expectedRevision !== undefined && tab.autosaveRevision !== expectedRevision) {
      return;
    }

    setTabs((previous) =>
      previous.map((item) => (item.id === tabId ? { ...item, isSaving: true } : item)),
    );

    try {
      const savingContent = tab.content;
      const result = await window.electronAPI.writeFileAtomic({
        path: tab.path,
        content: savingContent,
      });
      applySavedState(tabId, savingContent, result);
      setStatusMessage(`Saved ${tab.path}`);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, `Unable to save ${tab.path}`));
      setTabs((previous) =>
        previous.map((item) => (item.id === tabId ? { ...item, isSaving: false } : item)),
      );
    }
  }

  async function enterDirectory(remotePath: string): Promise<boolean> {
    setFileMenuOpen(false);
    const loaded = await refreshDirectory(remotePath, true);
    if (!loaded) {
      return false;
    }

    setWorkspacePath(remotePath);
    setSelectedTreePath(remotePath);
    setExpandedDirectories(new Set([remotePath]));
    setStatusMessage(`Entered ${remotePath}`);
    return true;
  }

  async function openNewWindow(): Promise<void> {
    setFileMenuOpen(false);

    try {
      await window.electronAPI.openNewWindow();
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to open a new connection window'));
    }
  }

  async function createEntry(parentPath: string, kind: 'directory' | 'file', rawName: string): Promise<void> {
    const name = rawName.trim();
    if (name === '') {
      return;
    }

    if (name.includes('/')) {
      throw new Error('Names cannot contain "/"');
    }

    const entry = await window.electronAPI.createEntry({
      parentPath,
      name,
      kind,
    });
    await refreshDirectory(parentPath, true);
    setSelectedTreePath(entry.path);
    setStatusMessage(`Created ${entry.path}`);

    if (entry.kind === 'file') {
      await openFile(entry.path);
    }
  }

  async function renameEntry(entry: RemoteDirectoryEntry, rawNextName: string): Promise<void> {
    const nextName = rawNextName.trim();
    if (nextName === '' || nextName === entry.name) {
      return;
    }

    if (nextName.includes('/')) {
      throw new Error('Names cannot contain "/"');
    }

    const parentPath = getParentPath(entry.path);
    const renamed = await window.electronAPI.renameEntry({
      path: entry.path,
      nextName,
    });

    await refreshDirectory(parentPath, true);
    setSelectedTreePath(renamed.path);
    setStatusMessage(`Renamed to ${renamed.path}`);

    setTabs((previous) =>
      previous.map((tab) => {
        if (tab.connectionId !== currentConnectionId) {
          return tab;
        }

        const nextPath = remapPathAfterRename(entry.path, renamed.path, tab.path);
        if (!nextPath) {
          return tab;
        }

        return {
          ...tab,
          id: buildTabId(tab.connectionId, nextPath),
          path: nextPath,
          name: nextPath.split('/').pop() || nextPath,
        };
      }),
    );

    if (currentConnectionId && activeTab?.connectionId === currentConnectionId) {
      const nextActivePath = remapPathAfterRename(entry.path, renamed.path, activeTab.path);
      if (nextActivePath) {
        setActiveTabId(buildTabId(currentConnectionId, nextActivePath));
      }
    }

    if (workspacePath === entry.path && renamed.kind === 'directory') {
      setWorkspacePath(renamed.path);
    }
  }

  async function deleteEntry(entry: RemoteDirectoryEntry): Promise<void> {
    const targetLabel = entry.kind === 'directory' ? `${entry.path} and all of its contents` : entry.path;
    if (!window.confirm(`Delete ${targetLabel}? This cannot be undone.`)) {
      return;
    }

    const operationId = crypto.randomUUID();
    retryRequestsRef.current.set(operationId, {
      kind: 'delete',
      request: { path: entry.path, operationId },
    });
    await window.electronAPI.deleteEntry({ path: entry.path, operationId });
    const parentPath = entry.kind === 'directory' ? getParentPath(entry.path) : getParentPath(entry.path);
    if (entry.path === workspacePath) {
      await refreshDirectory(rootPath, true);
      setWorkspacePath(rootPath);
      setSelectedTreePath(rootPath);
    } else {
      await refreshDirectory(parentPath, true);
      setSelectedTreePath(parentPath);
    }

    const deletedPrefix = `${entry.path}/`;
    setTabs((previous) =>
      previous.filter((tab) => tab.path !== entry.path && !tab.path.startsWith(deletedPrefix)),
    );
    if (activeTab && (activeTab.path === entry.path || activeTab.path.startsWith(deletedPrefix))) {
      setActiveTabId(null);
    }
    setStatusMessage(`Deleted ${entry.path}`);
  }

  async function uploadToDirectory(remotePath: string): Promise<void> {
    const localPaths = await window.electronAPI.pickUploadEntries();
    if (localPaths.length === 0) {
      return;
    }

    const operationId = crypto.randomUUID();
    const request: UploadLocalEntriesInput = {
      operationId,
      remotePath,
      localPaths,
      conflictStrategy: 'ask',
    };
    retryRequestsRef.current.set(operationId, {
      kind: 'upload',
      request,
    });
    const result = await window.electronAPI.uploadLocalEntries(request);
    if (result.status === 'conflict') {
      setConflictDialog({
        kind: 'upload',
        operationId,
        sourcePath: localPaths[0] ?? remotePath,
        targetPath: remotePath,
        localPaths,
        conflicts: result.conflicts,
      });
      return;
    }

    await refreshDirectory(remotePath, true);
    setStatusMessage(
      result.skippedItems > 0
        ? `Uploaded into ${remotePath} (${result.skippedItems} skipped)`
        : `Uploaded into ${remotePath}`,
    );
  }

  async function downloadEntry(entry: RemoteDirectoryEntry): Promise<void> {
    setStatusMessage(`Choose a local destination for ${entry.path}`);
    const downloadDirectory = await window.electronAPI.pickDownloadDirectory();
    if (!downloadDirectory) {
      setStatusMessage('Download canceled');
      return;
    }

    const operationId = crypto.randomUUID();
    const localPath = joinLocalPath(downloadDirectory, entry.name);
    const request: DownloadRemoteEntryInput = {
      operationId,
      remotePath: entry.path,
      localPath,
      conflictStrategy: 'ask',
    };
    retryRequestsRef.current.set(operationId, {
      kind: 'download',
      request,
    });
    const result = await window.electronAPI.downloadEntry(request);
    if (result.status === 'conflict') {
      setConflictDialog({
        kind: 'download',
        operationId,
        sourcePath: entry.path,
        targetPath: localPath,
        conflicts: result.conflicts,
      });
      return;
    }

    setStatusMessage(
      result.skippedItems > 0
        ? `Downloaded ${entry.path} (${result.skippedItems} skipped)`
        : `Downloaded ${entry.path}`,
    );
  }

  async function runSearch(): Promise<void> {
    const query = searchQuery.trim();
    if (query === '') {
      setSearchResults(null);
      return;
    }

    setSearchBusy(true);
    try {
      const result = await window.electronAPI.searchInFiles({
        rootPath: workspacePath,
        query,
        caseSensitive: searchCaseSensitive,
      });
      setSearchResults(result);
      setStatusMessage(
        `Found ${result.matches.length} matches for "${query}"${result.truncated ? ' (truncated)' : ''}`,
      );
    } catch (error) {
      setStatusMessage(getErrorMessage(error, `Unable to search in ${workspacePath}`));
    } finally {
      setSearchBusy(false);
    }
  }

  function openSearchDialog(): void {
    if (!isConnected) {
      return;
    }

    setSearchDialogOpen(true);
  }

  function closeSearchDialog(): void {
    if (searchBusy) {
      return;
    }

    setSearchDialogOpen(false);
  }

  function openQuickCommandsDialog(): void {
    setQuickCommandsDialogOpen(true);
  }

  function addQuickCommand(input: { name: string; command: string }): void {
    const nextCommand: QuickCommandItem = {
      id: createQuickCommandId(),
      name: input.name.trim(),
      command: input.command.trim(),
    };

    setQuickCommands((previous) => {
      const nextCommands = [nextCommand, ...previous].slice(0, 40);
      saveQuickCommands(nextCommands);
      return nextCommands;
    });
    setStatusMessage(`Added quick command ${nextCommand.name}`);
  }

  function deleteQuickCommand(commandId: string): void {
    setQuickCommands((previous) => {
      const deletedCommand = previous.find((command) => command.id === commandId);
      const nextCommands = previous.filter((command) => command.id !== commandId);
      saveQuickCommands(nextCommands);
      if (deletedCommand) {
        setStatusMessage(`Deleted quick command ${deletedCommand.name}`);
      }
      return nextCommands;
    });
  }

  function runQuickCommand(command: QuickCommandItem): void {
    void terminalPanelRef.current?.runCommand(command.command, command.name);
    setQuickCommandsDialogOpen(false);
  }

  function syncSavedConnectionTunnels(savedConnectionId: string, tunnels: SavedTunnelConfig[]): void {
    setSavedConnections((previous) =>
      previous.map((entry) =>
        entry.id === savedConnectionId
          ? {
              ...entry,
              tunnels,
            }
          : entry,
      ),
    );
  }

  function setTunnelBusy(tunnelId: string, busy: boolean): void {
    setBusyTunnelIds((previous) => {
      const next = new Set(previous);
      if (busy) {
        next.add(tunnelId);
      } else {
        next.delete(tunnelId);
      }
      return next;
    });
  }

  async function loadTunnelSnapshots(savedConnectionId = currentSavedConnectionId): Promise<void> {
    if (!savedConnectionId) {
      setTunnelSnapshots([]);
      return;
    }

    setTunnelDialogLoading(true);

    try {
      const snapshots: TunnelSnapshot[] = await window.electronAPI.listTunnels(savedConnectionId);
      setTunnelSnapshots(snapshots);
      syncSavedConnectionTunnels(
        savedConnectionId,
        snapshots.map((snapshot) => snapshot.config),
      );
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to load tunnels'));
    } finally {
      setTunnelDialogLoading(false);
    }
  }

  function openTunnelsDialog(): void {
    if (!isConnected || !currentSavedConnectionId) {
      setStatusMessage('Connect before opening tunnels');
      return;
    }

    setTunnelsDialogOpen(true);
  }

  async function startVisionMode(): Promise<void> {
    if (!isConnected) {
      setStatusMessage('Connect before starting vision mode');
      return;
    }

    setVisionModeBusy(true);
    try {
      const { display } = await window.electronAPI.enableVisionMode();
      const { streamId } = await window.electronAPI.startVideoStream({
        display,
        width: 1280,
        height: 720,
        fps: 15,
        quality: 5,
      });
      setVisionModeActive(true);
      setVisionStreamId(streamId);
      setStatusMessage(`Vision mode enabled on ${display}. DISPLAY exported to all open terminals.`);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to start vision mode'));
    } finally {
      setVisionModeBusy(false);
    }
  }

  async function stopVisionMode(): Promise<void> {
    setVisionModeBusy(true);
    try {
      if (visionStreamId) {
        await window.electronAPI.stopVideoStream(visionStreamId);
      }
      await window.electronAPI.disableVisionMode();
      setVisionModeActive(false);
      setVisionStreamId(null);
      setStatusMessage('Vision mode stopped');
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to stop vision mode'));
    } finally {
      setVisionModeBusy(false);
    }
  }

  async function toggleVisionMode(): Promise<void> {
    if (visionModeActive) {
      await stopVisionMode();
    } else {
      await startVisionMode();
    }
  }

  async function saveTunnel(config: SavedTunnelConfig): Promise<void> {
    if (!currentSavedConnectionId) {
      throw new Error('No saved connection available for tunnels');
    }

    setTunnelSaveBusy(true);

    try {
      await window.electronAPI.saveTunnel(currentSavedConnectionId, config);
      await loadTunnelSnapshots(currentSavedConnectionId);
      setStatusMessage(`Saved tunnel ${config.name}`);
    } finally {
      setTunnelSaveBusy(false);
    }
  }

  async function deleteTunnel(tunnelId: string): Promise<void> {
    if (!currentSavedConnectionId) {
      return;
    }

    const tunnel = tunnelSnapshots.find((snapshot) => snapshot.config.id === tunnelId)?.config;
    setTunnelBusy(tunnelId, true);

    try {
      await window.electronAPI.removeTunnel(currentSavedConnectionId, tunnelId);
      await loadTunnelSnapshots(currentSavedConnectionId);
      if (tunnel) {
        setStatusMessage(`Deleted tunnel ${tunnel.name}`);
      }
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to delete tunnel'));
    } finally {
      setTunnelBusy(tunnelId, false);
    }
  }

  async function startTunnel(tunnelId: string): Promise<void> {
    if (!currentSavedConnectionId) {
      return;
    }

    setTunnelBusy(tunnelId, true);
    try {
      await window.electronAPI.startTunnel(currentSavedConnectionId, tunnelId);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to start tunnel'));
    } finally {
      setTunnelBusy(tunnelId, false);
    }
  }

  async function stopTunnel(tunnelId: string): Promise<void> {
    setTunnelBusy(tunnelId, true);
    try {
      await window.electronAPI.stopTunnel(tunnelId);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to stop tunnel'));
    } finally {
      setTunnelBusy(tunnelId, false);
    }
  }

  function openCreateEntryDialog(parentPath: string, kind: 'directory' | 'file'): void {
    setFileMenuOpen(false);
    setEntryDialog({
      mode: 'create',
      entryKind: kind,
      parentPath,
      value: kind === 'directory' ? 'new-folder' : 'untitled.txt',
    });
  }

  function openRenameEntryDialog(entry: RemoteDirectoryEntry): void {
    setFileMenuOpen(false);
    setEntryDialog({
      mode: 'rename',
      entry,
      value: entry.name,
    });
  }

  function openFolderPicker(): void {
    setFileMenuOpen(false);
    setFolderPickerInitialPath(getActionDirectoryPath());
  }

  function closeFolderPicker(): void {
    if (folderPickerBusy) {
      return;
    }

    setFolderPickerInitialPath(null);
  }

  async function submitFolderPicker(remotePath: string): Promise<void> {
    setFolderPickerBusy(true);

    try {
      const entered = await enterDirectory(remotePath);
      if (entered) {
        setFolderPickerInitialPath(null);
      }
    } finally {
      setFolderPickerBusy(false);
    }
  }

  function closeEntryDialog(): void {
    if (entryDialogBusy) {
      return;
    }

    setEntryDialog(null);
  }

  async function submitEntryDialog(): Promise<void> {
    if (!entryDialog) {
      return;
    }

    const nextValue = entryDialog.value.trim();
    if (nextValue === '') {
      return;
    }

    setEntryDialogBusy(true);

    try {
      if (entryDialog.mode === 'create') {
        await createEntry(entryDialog.parentPath, entryDialog.entryKind, nextValue);
      } else {
        await renameEntry(entryDialog.entry, nextValue);
      }

      setEntryDialog(null);
    } catch (error) {
      const fallback =
        entryDialog.mode === 'create'
          ? `Unable to create ${entryDialog.entryKind === 'directory' ? 'folder' : 'file'} in ${entryDialog.parentPath}`
          : `Unable to rename ${entryDialog.entry.path}`;
      setStatusMessage(getErrorMessage(error, fallback));
    } finally {
      setEntryDialogBusy(false);
    }
  }

  function closeConflictDialog(): void {
    setConflictDialog(null);
  }

  async function resolveConflictDialog(strategy: Exclude<FileConflictStrategy, 'ask'>): Promise<void> {
    if (!conflictDialog) {
      return;
    }

    const dialog = conflictDialog;
    setConflictDialog(null);

    if (dialog.kind === 'upload') {
      const request: UploadLocalEntriesInput = {
        operationId: dialog.operationId,
        remotePath: dialog.targetPath,
        localPaths: dialog.localPaths ?? [],
        conflictStrategy: strategy,
      };
      retryRequestsRef.current.set(dialog.operationId, { kind: 'upload', request });
      const result = await window.electronAPI.uploadLocalEntries(request);
      if (result.status === 'completed') {
        await refreshDirectory(dialog.targetPath, true);
      }
      return;
    }

    const request: DownloadRemoteEntryInput = {
      operationId: dialog.operationId,
      remotePath: dialog.sourcePath,
      localPath: dialog.targetPath,
      conflictStrategy: strategy,
    };
    retryRequestsRef.current.set(dialog.operationId, { kind: 'download', request });
    const result = await window.electronAPI.downloadEntry(request);
    if (result.status === 'conflict') {
      setConflictDialog(dialog);
    }
  }

  async function retryFileOperation(operation: FileOperationItem): Promise<void> {
    try {
      const retryRequest = retryRequestsRef.current.get(operation.operationId);
      if (!retryRequest) {
        setStatusMessage('Retry context expired. Start the operation again.');
        return;
      }

      if (retryRequest.kind === 'delete') {
        await window.electronAPI.deleteEntry(retryRequest.request);
        return;
      }

      if (retryRequest.kind === 'upload') {
        await window.electronAPI.uploadLocalEntries({
          ...retryRequest.request,
          conflictStrategy: 'overwrite',
        });
        await refreshDirectory(retryRequest.request.remotePath, true);
        return;
      }

      await window.electronAPI.downloadEntry({
        ...retryRequest.request,
        conflictStrategy: 'overwrite',
      });
    } catch (error) {
      setStatusMessage(getErrorMessage(error, `Unable to retry ${operation.kind}`));
    }
  }

  async function reconnect(): Promise<void> {
    if (!reconnectTarget) {
      return;
    }

    const savedConnection = savedConnections.find((entry) => entry.id === reconnectTarget.savedConnectionId);
    if (!savedConnection) {
      setStatusMessage('Saved connection no longer exists');
      return;
    }

    setReconnectBusy(true);
    try {
      await connectSaved(savedConnection, reconnectTarget.workspacePath);
    } finally {
      setReconnectBusy(false);
    }
  }

  function closeTailscaleAuthDialog(): void {
    setTailscaleAuthDialog(null);
  }

  async function copyTailscaleAuthUrl(): Promise<void> {
    if (!tailscaleAuthDialog) {
      return;
    }

    try {
      await navigator.clipboard.writeText(tailscaleAuthDialog.url);
      setTailscaleAuthDialog((previous) => (previous ? { ...previous, copied: true } : previous));
      setStatusMessage('Copied Tailscale login link');
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to copy login link'));
    }
  }

  function applySavedState(tabId: string, savedContent: string, _result: SaveRemoteFileResult): void {
    setTabs((previous) =>
      previous.map((item) =>
        item.id === tabId
          ? {
              ...item,
              savedContent,
              isSaving: false,
            }
          : item,
      ),
    );
  }

  const isConnected = connectionStatus.state === 'connected';
  const fileSystemReady = connectionStatus.filesystemState === 'ready';
  const connectionDiagnosticLabel = getConnectionDiagnosticLabel(connectionStatus.diagnosticCode);

  useEffect(() => {
    if (!fileSystemReady) {
      if (idlePrefetchTimerRef.current) {
        clearTimeout(idlePrefetchTimerRef.current);
        idlePrefetchTimerRef.current = null;
      }
      return;
    }

    const currentEntries = entriesByDirectory[workspacePath] ?? [];
    const prefetchCandidates = currentEntries
      .filter((entry) => entry.kind === 'directory' && !entriesByDirectory[entry.path])
      .slice(0, 4);

    if (prefetchCandidates.length === 0) {
      return;
    }

    idlePrefetchTimerRef.current = setTimeout(() => {
      idlePrefetchTimerRef.current = null;
      for (const entry of prefetchCandidates) {
        void refreshDirectory(entry.path);
      }
    }, 400);

    return () => {
      if (idlePrefetchTimerRef.current) {
        clearTimeout(idlePrefetchTimerRef.current);
        idlePrefetchTimerRef.current = null;
      }
    };
  }, [entriesByDirectory, fileSystemReady, workspacePath]);

  function getActionDirectoryPath(): string {
    if (selectedEntry?.kind === 'directory') {
      return selectedEntry.path;
    }

    if (selectedEntry?.kind === 'file') {
      return getParentPath(selectedEntry.path);
    }

    return workspacePath;
  }

  const handleSelectTreePath = useStableCallback((remotePath: string) => {
    setSelectedTreePath(remotePath);
  });
  const handleToggleDirectory = useStableCallback((remotePath: string) => {
    void toggleDirectory(remotePath);
  });
  const handleOpenFile = useStableCallback((remotePath: string) => {
    void openFile(remotePath);
  });
  const handleRefreshDirectory = useStableCallback((remotePath: string) => {
    void refreshDirectory(remotePath, true);
  });
  const handleOpenTreeContextMenu = useStableCallback(
    (remotePath: string, kind: 'directory' | 'file', position: { x: number; y: number }) => {
      setTreeContextMenu({
        path: remotePath,
        kind,
        x: position.x,
        y: position.y,
      });
    },
  );
  const handleTreeContextMenuAction = useStableCallback(
    (
      action: 'upload' | 'download' | 'idle-download' | 'rename' | 'delete' | 'create-file' | 'create-folder',
      path: string,
    ) => {
      setTreeContextMenu(null);
      const entry =
        path === workspacePath
          ? ({
              path: workspacePath,
              name: workspaceName,
              kind: 'directory',
            } satisfies RemoteDirectoryEntry)
          : Object.values(entriesByDirectory)
              .flat()
              .find((item) => item.path === path);

      if (!entry) {
        return;
      }

      setSelectedTreePath(entry.path);

      if (action === 'upload' && entry.kind === 'directory') {
        void uploadToDirectory(entry.path).catch((error) => {
          setStatusMessage(getErrorMessage(error, `Unable to upload into ${entry.path}`));
        });
        return;
      }

      if (action === 'download') {
        void downloadEntry(entry).catch((error) => {
          setStatusMessage(getErrorMessage(error, `Unable to download ${entry.path}`));
        });
        return;
      }

      if (action === 'idle-download') {
        setStatusMessage(`Choosing destination for idle download of ${entry.path}`);
        void window.electronAPI
          .queueIdleDownload({ remotePath: entry.path })
          .then((snapshot) => {
            if (snapshot) {
              setIdleTransferSnapshot(snapshot);
              setStatusMessage(
                `Idle download queued (${snapshot.queuedItems} item${snapshot.queuedItems === 1 ? '' : 's'} waiting)`,
              );
            }
          })
          .catch((error) => {
            setStatusMessage(getErrorMessage(error, `Unable to queue ${entry.path}`));
          });
        return;
      }

      if (action === 'rename') {
        openRenameEntryDialog(entry);
        return;
      }

      if (action === 'delete') {
        void deleteEntry(entry).catch((error) => {
          setStatusMessage(getErrorMessage(error, `Unable to delete ${entry.path}`));
        });
        return;
      }

      if (action === 'create-file' && entry.kind === 'directory') {
        openCreateEntryDialog(entry.path, 'file');
        return;
      }

      if (action === 'create-folder' && entry.kind === 'directory') {
        openCreateEntryDialog(entry.path, 'directory');
      }
    },
  );

  const entryDialogMeta =
    entryDialog?.mode === 'rename'
      ? {
          title: 'Rename',
          description: entryDialog.entry.path,
          submitLabel: 'Rename',
        }
      : entryDialog
        ? {
            title: entryDialog.entryKind === 'directory' ? 'New Folder' : 'New File',
            description: `Create in ${entryDialog.parentPath}`,
            submitLabel: entryDialog.entryKind === 'directory' ? 'Create Folder' : 'Create File',
          }
        : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="menu-bar">
          <div className="menu-bar-left">
            <div className="product-name">SSH Studio</div>
            <div className="menu-wrap" ref={fileMenuRef}>
              <button
                type="button"
                className={`menu-button ${fileMenuOpen ? 'menu-button-open' : ''}`}
                onClick={() => {
                  setFileMenuOpen((previous) => !previous);
                }}
              >
                <span>File</span>
                <ChevronDown size={13} />
              </button>

              {fileMenuOpen ? (
                <div className="menu-dropdown">
              <button
                type="button"
                className="menu-item"
                disabled={!isConnected || !fileSystemReady}
                onClick={() => {
                  openFolderPicker();
                }}
                  >
                    Open Folder
                  </button>
                  <button
                type="button"
                className="menu-item"
                disabled={!isConnected || !fileSystemReady}
                onClick={() => {
                  openCreateEntryDialog(getActionDirectoryPath(), 'file');
                }}
                  >
                    New File
                  </button>
                  <button
                type="button"
                className="menu-item"
                disabled={!isConnected || !fileSystemReady}
                onClick={() => {
                  openCreateEntryDialog(getActionDirectoryPath(), 'directory');
                }}
                  >
                    New Folder
                  </button>
                  <div className="menu-divider" />
                  <button
                    type="button"
                    className="menu-item"
                    disabled={!isConnected || !fileSystemReady}
                    onClick={() => {
                      void uploadToDirectory(getActionDirectoryPath()).catch((error) => {
                        setStatusMessage(getErrorMessage(error, 'Unable to upload files'));
                      });
                    }}
                  >
                    Upload Here…
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    disabled={!isConnected || !fileSystemReady || !selectedEntry}
                    onClick={() => {
                      if (selectedEntry) {
                        void downloadEntry(selectedEntry).catch((error) => {
                          setStatusMessage(getErrorMessage(error, `Unable to download ${selectedEntry.path}`));
                        });
                      }
                    }}
                  >
                    Download Selected…
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    disabled={!selectedEntry}
                    onClick={() => {
                      if (selectedEntry) {
                        openRenameEntryDialog(selectedEntry);
                      }
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="menu-item menu-item-danger"
                    disabled={!isConnected || !fileSystemReady || !selectedEntry}
                    onClick={() => {
                      if (selectedEntry) {
                        void deleteEntry(selectedEntry).catch((error) => {
                          setStatusMessage(getErrorMessage(error, `Unable to delete ${selectedEntry.path}`));
                        });
                      }
                    }}
                  >
                    Delete Selected
                  </button>
                  <div className="menu-divider" />
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      void openNewWindow();
                    }}
                  >
                    New Connection
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    disabled={!isConnected}
                    onClick={() => {
                      void disconnect();
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              ) : null}
            </div>
            {downloadQueue.operations.length > 0 ? (<button
              type="button"
              className="menu-button topbar-tool-button"
              disabled={!isConnected}
              onClick={() => {
                openSearchDialog();
              }}
              title="Global Search (Ctrl/Cmd+Shift+F)"
            >
              <Search size={13} />
              <span>Search</span>
            </button>) : null}
            <button
              type="button"
              className="menu-button topbar-tool-button"
              onClick={() => {
                openQuickCommandsDialog();
              }}
              title="Quick Commands (Ctrl/Cmd+Shift+P)"
            >
              <TerminalSquare size={13} />
              <span>Commands</span>
            </button>
            <button
              type="button"
              className="menu-button topbar-tool-button"
              disabled={!isConnected || !currentSavedConnectionId}
              onClick={() => {
                openTunnelsDialog();
              }}
              title="Tunnels (Ctrl/Cmd+Shift+T)"
            >
              <PlugZap size={13} />
              <span>Tunnels</span>
            </button>
            <button
              type="button"
              className={`menu-button topbar-tool-button vision-mode-button${visionModeActive ? ' vision-mode-active' : ''}`}
              disabled={!isConnected || visionModeBusy}
              onClick={() => {
                void toggleVisionMode();
              }}
              title="开启后会在远程主机上启动虚拟显示，并向所有已打开终端注入 DISPLAY 环境变量，无需修改视觉代码本身"
            >
              <Camera size={13} />
              <span>{visionModeActive ? '停止视觉观测' : '视觉观测'}</span>
            </button>
          </div>

          <div className="menu-bar-center" title={workspacePath}>
            {isConnected ? workspaceName : 'No folder open'}
          </div>
        </div>

        <div className="status-cluster">
          {isConnected ? <HostMetricsBar snapshot={hostMetrics} error={hostMetricsError} /> : null}
          <span className={`state-badge state-${connectionStatus.state}`}>{connectionStatus.state}</span>
          {connectionDiagnosticLabel ? <span className="status-diagnostic">{connectionDiagnosticLabel}</span> : null}
          <span className="status-text">{statusMessage}</span>
          {reconnectTarget && !isConnected ? (
            <button
              type="button"
              className="status-action-button"
              onClick={() => {
                void reconnect();
              }}
              disabled={reconnectBusy || busyAction !== null}
              title={connectionStatus.recoveryHint ?? 'Reconnect using the last saved connection'}
            >
              {reconnectBusy ? <RefreshCw className="spin" size={14} /> : <RefreshCw size={14} />}
              <span>Reconnect</span>
            </button>
          ) : null}
        </div>
      </header>

      {showConnectionScreen ? (
        <main className="launch-screen">
          <div className="launch-card">
            <ConnectionForm
              value={connectionForm}
              status={connectionStatus}
              mode="launch"
              isBusy={busyAction !== null}
              savedConnections={savedConnections}
              tailscaleHosts={tailscaleHosts}
              isLoadingTailscaleHosts={isLoadingTailscaleHosts}
              isLoadingSavedConnections={isLoadingSavedConnections}
              activeSavedConnectionId={activeSavedConnectionId}
              removingSavedConnectionId={removingSavedConnectionId}
              onChange={setConnectionForm}
              onConnect={() => {
                void connect();
              }}
              onConnectTailscaleHost={(host) => {
                const nextForm = applyTailscaleHost(host);
                void connect(nextForm);
              }}
              onRefreshTailscaleHosts={() => {
                void loadTailscaleHosts();
              }}
              onConnectSaved={(savedConnectionId) => {
                const savedConnection = savedConnections.find((entry) => entry.id === savedConnectionId);
                if (!savedConnection) {
                  return;
                }

                void connectSaved(savedConnection);
              }}
              onConnectSavedWorkspace={(savedConnectionId, workspacePath) => {
                const savedConnection = savedConnections.find((entry) => entry.id === savedConnectionId);
                if (!savedConnection) {
                  return;
                }

                void connectSaved(savedConnection, workspacePath);
              }}
              onRemoveSaved={(savedConnectionId) => {
                void removeSavedConnection(savedConnectionId);
              }}
              onRenameSaved={(savedConnectionId) => {
                openRenameSavedConnectionDialog(savedConnectionId);
              }}
              onImportSshConfig={() => {
                void importSshConfig();
              }}
              isImportingSshConfig={isImportingSshConfig}
              onDisconnect={() => {
                void disconnect();
              }}
            />
            {connectionStatus.authUrl ? (
              <div className="launch-auth-banner">
                <div className="connection-banner-copy">
                  <strong>Browser login required</strong>
                  <span>{connectionStatus.recoveryHint ?? statusMessage}</span>
                </div>
                <button
                  type="button"
                  className="secondary-button connection-banner-action"
                  onClick={() => {
                    void window.electronAPI.openExternal(connectionStatus.authUrl!);
                  }}
                  disabled={busyAction !== null}
                >
                  <ExternalLink size={16} />
                  <span>Open Login Link</span>
                </button>
              </div>
            ) : null}
          </div>
        </main>
      ) : (
      <PanelGroup direction="vertical" className="app-panels">
        {connectionStatus.state !== 'connected' ? (
          <section className="connection-banner">
            <div className="connection-banner-copy">
              <strong>{connectionDiagnosticLabel ?? connectionStatus.state}</strong>
              <span>{connectionStatus.recoveryHint ?? statusMessage}</span>
            </div>
            <div className="connection-banner-actions">
              {connectionStatus.authUrl ? (
                <button
                  type="button"
                  className="secondary-button connection-banner-action"
                  onClick={() => {
                    void window.electronAPI.openExternal(connectionStatus.authUrl!);
                  }}
                  disabled={busyAction !== null}
                >
                  <ExternalLink size={16} />
                  <span>Open Login Link</span>
                </button>
              ) : null}
              {reconnectTarget ? (
                <button
                  type="button"
                  className="primary-button connection-banner-action"
                  onClick={() => {
                    void reconnect();
                  }}
                  disabled={reconnectBusy || busyAction !== null}
                >
                  {reconnectBusy ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}
                  <span>Reconnect</span>
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
        <Panel defaultSize={72} minSize={46}>
          <PanelGroup direction="horizontal">
            <Panel defaultSize={18} minSize={14} maxSize={24}>
              <aside className="sidebar">
                <div className="sidebar-toolbar">
                  <div className="section-heading">
                    <span>{workspaceName}</span>
                    <label className="toggle-row" title="Auto save changes after a short delay">
                      <input
                        type="checkbox"
                        checked={autoSaveEnabled}
                        onChange={(event) => {
                          setAutoSaveEnabled(event.target.checked);
                        }}
                      />
                      <span>Auto Save</span>
                    </label>
                  </div>
                </div>

                <FileTree
                  workspacePath={workspacePath}
                  entriesByDirectory={entriesByDirectory}
                  expandedDirectories={expandedDirectories}
                  loadingDirectories={loadingDirectories}
                  activeFilePath={activeTab?.path ?? null}
                  selectedPath={selectedTreePath}
                  onSelectPath={handleSelectTreePath}
                  onToggleDirectory={handleToggleDirectory}
                  onOpenFile={handleOpenFile}
                  onRefreshDirectory={handleRefreshDirectory}
                  onOpenContextMenu={handleOpenTreeContextMenu}
                />
                {!fileSystemReady ? (
                  <div className="sidebar-overlay">
                    <RefreshCw className={connectionStatus.filesystemState === 'loading' ? 'spin' : ''} size={16} />
                    <span>{getFileSystemStatusText(connectionStatus.filesystemState)}</span>
                  </div>
                ) : null}
              </aside>
            </Panel>

            <PanelResizeHandle className="panel-handle panel-handle-vertical" />

            <Panel minSize={30}>
              <section className="editor-panel">
                <EditorTabs
                  tabs={tabs}
                  activeTabId={activeTabId}
                  currentConnectionId={currentConnectionId}
                  autoSaveEnabled={autoSaveEnabled}
                  onSelect={setActiveTabId}
                  onClose={closeTab}
                  onSave={(tabId) => {
                    void saveTab(tabId);
                  }}
                />

                <div className="editor-surface">
                  {activeTab?.kind === 'image' && activeTab.imageDataUrl ? (
                    <ImagePreview
                      path={activeTab.path}
                      dataUrl={activeTab.imageDataUrl}
                      byteLength={activeTab.byteLength ?? 0}
                      modifiedAt={activeTab.modifiedAt}
                      isReloading={reloadingImagePath === activeTab.path}
                      autoRefresh={imageAutoRefresh}
                      onToggleAutoRefresh={setImageAutoRefresh}
                      onReload={() => {
                        void reloadImageTab(activeTab.id);
                      }}
                    />
                  ) : activeTab ? (
                    <Suspense fallback={<EditorLoading spinning={isLoadingFile} />}>
                      <RemoteEditor
                        isLoadingFile={isLoadingFile}
                        language={detectLanguage(activeTab.path)}
                        tab={activeTab}
                        revealTarget={
                          editorRevealTarget?.tabId === activeTab.id
                            ? { line: editorRevealTarget.line, column: editorRevealTarget.column }
                            : null
                        }
                        onChange={updateActiveTabContent}
                      />
                    </Suspense>
                  ) : (
                    <div className="editor-empty">
                      <FolderSearch size={28} />
                      <h2>No file open</h2>
                      <p>Choose a remote file from the left pane to start editing.</p>
                    </div>
                  )}
                </div>
              </section>
            </Panel>
          </PanelGroup>
        </Panel>

        <PanelResizeHandle className="panel-handle panel-handle-horizontal" />

        <Panel defaultSize={28} minSize={16}>
          <TerminalPanel
            ref={terminalPanelRef}
            connectionStatus={connectionStatus}
            workspacePath={workspacePath}
            onStatusMessage={setStatusMessage}
          />
        </Panel>
      </PanelGroup>
      )}

      <footer className="statusbar">
        <div className="statusbar-section">
          <CircleAlert size={14} />
          <span>{statusMessage}</span>
        </div>
        {downloadQueue.operations.length > 0 || (idleTransferSnapshot?.manualGroups.length ?? 0) > 0 ? (
          <div className="download-queue-control">
            {downloadQueue.operations.length > 0 ? (
            <button
              type="button"
              className={`statusbar-section statusbar-file-op statusbar-file-op-${downloadQueue.status ?? 'completed'} statusbar-queue-button`}
              onClick={() => setDownloadQueueOpen((open) => !open)}
              aria-expanded={downloadQueueOpen}
            >
              <span>
                {downloadQueue.operations.length > 0
                  ? `Download ${downloadQueue.completedItems}/${downloadQueue.totalItems}`
                  : 'Downloads'}
                {(idleTransferSnapshot?.manualGroups.length ?? 0) > 0
                  ? ` · ${idleTransferSnapshot!.manualGroups.length} idle task${idleTransferSnapshot!.manualGroups.length === 1 ? '' : 's'}`
                  : ''}
              </span>
              {downloadQueue.status === 'running' && downloadQueue.totalBytes > 0 ? (
                <div className="statusbar-transfer">
                  <progress
                    className="statusbar-transfer-bar"
                    max={downloadQueue.totalBytes}
                    value={downloadQueue.transferredBytes}
                  />
                  <span className="statusbar-transfer-detail">
                    {Math.min(100, Math.floor((downloadQueue.transferredBytes / downloadQueue.totalBytes) * 100))}% ·{' '}
                    {formatBytes(downloadQueue.transferredBytes)}/{formatBytes(downloadQueue.totalBytes)}
                    {formatRate(downloadQueue.bytesPerSecond) ? ` · ${formatRate(downloadQueue.bytesPerSecond)}` : ''}
                    {formatEta(downloadQueue.etaSeconds) ? ` · ETA ${formatEta(downloadQueue.etaSeconds)}` : ''}
                  </span>
                </div>
              ) : null}
            </button>
            ) : null}
            {downloadQueueOpen ? (
              <div className="download-queue-popover" role="dialog" aria-label="Download queue">
                <div className="download-queue-heading">Download queue</div>
                <div className="download-queue-list">
                  {downloadQueue.operations.map((operation) => (
                    <div key={operation.operationId} className="download-queue-item">
                      <div className="download-queue-item-copy">
                        <span className="download-queue-path" title={operation.currentPath ?? operation.sourcePath}>
                          {operation.currentPath ?? operation.sourcePath}
                        </span>
                        <span>
                          {operation.status === 'running'
                            ? `Downloading · ${operation.completedItems + operation.skippedItems}/${operation.totalItems}`
                            : operation.error ?? operation.message}
                        </span>
                      </div>
                      {operation.status === 'running' ? (
                        <button
                          type="button"
                          className="status-inline-button"
                          onClick={() => {
                            void window.electronAPI.cancelFileOperation(operation.operationId);
                          }}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {idleTransferSnapshot?.manualGroups.map((group) => (
                    <details key={`idle-group-${group.rootPath}`} className="download-queue-group">
                      <summary>
                        <span className="download-queue-path" title={group.rootPath}>{group.rootPath}</span>
                        <span>
                          Idle · {group.activePath ? '1 active' : '0 active'}, {group.queuedPaths.length} waiting
                        </span>
                        <button
                          type="button"
                          className="status-inline-button"
                          onClick={(event) => {
                            event.preventDefault();
                            void window.electronAPI.cancelIdleDownloadGroup(group.rootPath).then(setIdleTransferSnapshot);
                          }}
                        >
                          Cancel all
                        </button>
                      </summary>
                      <div className="download-queue-group-items">
                        {group.activePath ? <span>{group.activePath} · Downloading</span> : null}
                        {group.queuedPaths.map((remotePath) => <span key={remotePath}>{remotePath} · Waiting</span>)}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {visibleFileOperations.length > 0 ? (
          <div className="statusbar-file-operations" aria-label="File operations">
            {visibleFileOperations.map((operation) => (
              <div
                key={operation.operationId}
                className={`statusbar-section statusbar-file-op statusbar-file-op-${operation.status}`}
              >
                <span title={operation.currentPath ?? operation.sourcePath}>
                  {getFileOperationLabel(operation.kind)} {operation.completedItems}/{operation.totalItems}
                </span>
                {operation.status === 'running' &&
                typeof operation.totalBytes === 'number' &&
                operation.totalBytes > 0 ? (
                  (() => {
                    const transferred = operation.transferredBytes ?? 0;
                    const total = operation.totalBytes;
                    const pct = Math.min(100, Math.floor((transferred / total) * 100));
                    const rate = formatRate(operation.bytesPerSecond);
                    const eta = formatEta(operation.etaSeconds);
                    return (
                      <div className="statusbar-transfer">
                        <progress className="statusbar-transfer-bar" max={total} value={transferred} />
                        <span className="statusbar-transfer-detail">
                          {pct}% · {formatBytes(transferred)}/{formatBytes(total)}
                          {rate ? ` · ${rate}` : ''}
                          {eta ? ` · ETA ${eta}` : ''}
                        </span>
                      </div>
                    );
                  })()
                ) : (
                  <span>{operation.error ?? operation.message}</span>
                )}
                {operation.status === 'running' ? (
                  <button
                    type="button"
                    className="status-inline-button"
                    onClick={() => {
                      void window.electronAPI.cancelFileOperation(operation.operationId);
                    }}
                  >
                    Cancel
                  </button>
                ) : null}
                {operation.retryable && operation.status !== 'running' ? (
                  <button
                    type="button"
                    className="status-inline-button"
                    onClick={() => {
                      void retryFileOperation(operation);
                    }}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="statusbar-section">
          <span>{getFileSystemStatusText(connectionStatus.filesystemState)}</span>
        </div>
        <div className="statusbar-section">
          <span>{autoSaveEnabled ? 'Auto Save On' : 'Auto Save Off'}</span>
        </div>
        <div className={`statusbar-section statusbar-lsp statusbar-lsp-${languageServerState.status}`} title={languageServerState.message}>
          <span>
            LSP {languageServerState.status === 'ready'
              ? 'Ready'
              : languageServerState.status === 'starting'
                ? 'Starting'
                : languageServerState.status === 'unavailable'
                  ? 'Unavailable'
                  : languageServerState.status === 'error'
                    ? 'Error'
                    : 'Idle'}
          </span>
        </div>
        <div className="statusbar-section">
          <span>{activeTunnelCount} tunnel{activeTunnelCount === 1 ? '' : 's'} active</span>
        </div>
        <div className="statusbar-section">
          <span>{activeTab ? activeTab.path : 'No active file'}</span>
        </div>
      </footer>

      {entryDialog && entryDialogMeta ? (
        <EntryDialog
          title={entryDialogMeta.title}
          description={entryDialogMeta.description}
          value={entryDialog.value}
          submitLabel={entryDialogMeta.submitLabel}
          isBusy={entryDialogBusy}
          onChange={(value) => {
            setEntryDialog((previous) => (previous ? { ...previous, value } : previous));
          }}
          onCancel={closeEntryDialog}
          onSubmit={() => {
            void submitEntryDialog();
          }}
        />
      ) : null}

      {folderPickerInitialPath ? (
        <FolderPickerDialog
          initialPath={folderPickerInitialPath}
          homePath={rootPath}
          isBusy={folderPickerBusy}
          onReadDirectory={window.electronAPI.readDir}
          onCancel={closeFolderPicker}
          onConfirm={(remotePath) => {
            void submitFolderPicker(remotePath);
          }}
        />
      ) : null}

      {savedConnectionRenameDialog ? (
        <EntryDialog
          title="Rename Connection"
          description="Set a custom label for this saved connection."
          value={savedConnectionRenameDialog.value}
          submitLabel="Save Name"
          isBusy={savedConnectionRenameBusy}
          onChange={(value) => {
            setSavedConnectionRenameDialog((previous) =>
              previous
                ? {
                    ...previous,
                    value,
                  }
                : previous,
            );
          }}
          onCancel={closeSavedConnectionRenameDialog}
          onSubmit={() => {
            void submitSavedConnectionRenameDialog();
          }}
        />
      ) : null}

      {searchDialogOpen ? (
        <SearchDialog
          isBusy={searchBusy}
          query={searchQuery}
          caseSensitive={searchCaseSensitive}
          workspacePath={workspacePath}
          groupedResults={groupedSearchResults}
          resultCount={searchResults?.matches.length ?? 0}
          truncated={searchResults?.truncated ?? false}
          onChangeQuery={setSearchQuery}
          onToggleCaseSensitive={setSearchCaseSensitive}
          onClose={closeSearchDialog}
          onRunSearch={() => {
            void runSearch();
          }}
          onOpenMatch={(path, line, column) => {
            void openFile(path, { line, column });
          }}
        />
      ) : null}

      {quickCommandsDialogOpen ? (
        <QuickCommandsDialog
          commands={quickCommands}
          isConnected={isConnected}
          workspacePath={workspacePath}
          onAddCommand={addQuickCommand}
          onDeleteCommand={deleteQuickCommand}
          onRunCommand={runQuickCommand}
          onClose={() => {
            setQuickCommandsDialogOpen(false);
          }}
        />
      ) : null}

      {tunnelsDialogOpen ? (
        <TunnelsDialog
          tunnels={tunnelSnapshots}
          isConnected={isConnected}
          isLoading={tunnelDialogLoading}
          isSaving={tunnelSaveBusy}
          busyTunnelIds={busyTunnelIds}
          workspacePath={workspacePath}
          onSaveTunnel={saveTunnel}
          onDeleteTunnel={deleteTunnel}
          onStartTunnel={startTunnel}
          onStopTunnel={stopTunnel}
          onClose={() => {
            setTunnelsDialogOpen(false);
          }}
        />
      ) : null}

      {treeContextMenu ? (
        <div
          ref={treeContextMenuRef}
          className="tree-context-menu"
          style={{ left: treeContextMenu.x, top: treeContextMenu.y }}
        >
          {treeContextMenu.kind === 'directory' ? (
            <>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={() => {
                  handleTreeContextMenuAction('upload', treeContextMenu.path);
                }}
              >
                <Upload size={14} />
                <span>Upload Here</span>
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={() => {
                  handleTreeContextMenuAction('download', treeContextMenu.path);
                }}
              >
                <Download size={14} />
                <span>Download</span>
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={() => {
                  handleTreeContextMenuAction('create-file', treeContextMenu.path);
                }}
              >
                <Search size={14} />
                <span>New File</span>
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={() => {
                  handleTreeContextMenuAction('create-folder', treeContextMenu.path);
                }}
              >
                <Search size={14} />
                <span>New Folder</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tree-context-menu-item"
              onClick={() => {
                handleTreeContextMenuAction('download', treeContextMenu.path);
              }}
            >
              <Download size={14} />
              <span>Download</span>
            </button>
          )}

          <button
            type="button"
            className="tree-context-menu-item"
            onClick={() => {
              handleTreeContextMenuAction('idle-download', treeContextMenu.path);
            }}
            title="Downloads only while the SSH connection is otherwise idle"
          >
            <Download size={14} />
            <span>Idle Download…</span>
          </button>
          <button
            type="button"
            className="tree-context-menu-item"
            onClick={() => {
              handleTreeContextMenuAction('rename', treeContextMenu.path);
            }}
          >
            <PencilLine size={14} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            className="tree-context-menu-item tree-context-menu-item-danger"
            onClick={() => {
              handleTreeContextMenuAction('delete', treeContextMenu.path);
            }}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </div>
      ) : null}

      {conflictDialog ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeConflictDialog();
            }
          }}
        >
          <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="conflict-dialog-title">
            <div className="dialog-header">
              <div>
                <h2 id="conflict-dialog-title">Conflicting Files</h2>
                <p>{conflictDialog.conflicts.length} existing item(s) found. Choose how to proceed.</p>
              </div>
            </div>
            <div className="conflict-list">
              {conflictDialog.conflicts.slice(0, 8).map((conflict) => (
                <div key={conflict.path} className="conflict-list-item">
                  <strong>{conflict.kind}</strong>
                  <span>{conflict.path}</span>
                </div>
              ))}
              {conflictDialog.conflicts.length > 8 ? (
                <div className="conflict-list-item">
                  <span>+{conflictDialog.conflicts.length - 8} more</span>
                </div>
              ) : null}
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={closeConflictDialog}>
                Cancel
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void resolveConflictDialog('skip');
                }}
              >
                Skip Existing
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void resolveConflictDialog('overwrite');
                }}
              >
                Overwrite
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tailscaleAuthDialog ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeTailscaleAuthDialog();
            }
          }}
        >
          <section className="dialog-card tailscale-auth-dialog">
            <div className="dialog-header">
              <div>
                <h2>Tailscale Login Required</h2>
                <p>Open or copy the link below to finish Tailscale SSH verification, then come back here.</p>
              </div>
              <button
                type="button"
                className="icon-button dialog-close-button"
                onClick={closeTailscaleAuthDialog}
                aria-label="Close login dialog"
              >
                <X size={16} />
              </button>
            </div>

            <div className="dialog-form">
              <label className="dialog-field">
                <span>Login Link</span>
                <input value={tailscaleAuthDialog.url} readOnly />
              </label>
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void copyTailscaleAuthUrl();
                }}
              >
                {tailscaleAuthDialog.copied ? <Check size={16} /> : <Copy size={16} />}
                <span>{tailscaleAuthDialog.copied ? 'Copied' : 'Copy Link'}</span>
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void window.electronAPI.openExternal(tailscaleAuthDialog.url);
                }}
              >
                <ExternalLink size={16} />
                <span>Open in Browser</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
