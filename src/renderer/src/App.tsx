import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ChevronDown, CircleAlert, FolderSearch, RefreshCw, Search, Download, Upload, Trash2, PencilLine, TerminalSquare } from 'lucide-react';
import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ConnectInput,
  ConnectResult,
  ConnectionStatePayload,
  RemoteFileSystemState,
  RemoteDirectoryEntry,
  SavedConnectionSummary,
  SaveRemoteFileResult,
  SearchRemoteFilesResult,
} from '../../shared/contracts';
import { ConnectionForm } from './components/ConnectionForm';
import { EntryDialog } from './components/EntryDialog';
import { EditorTabs, type EditorTabItem } from './components/EditorTabs';
import { FileTree } from './components/FileTree';
import { FolderPickerDialog } from './components/FolderPickerDialog';
import { QuickCommandsDialog, type QuickCommandItem } from './components/QuickCommandsDialog';
import { SearchDialog } from './components/SearchDialog';
import { TerminalPanel, type TerminalPanelHandle } from './components/TerminalPanel';

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
};

const DEFAULT_CONNECTION_STATUS: ConnectionStatePayload = {
  state: 'disconnected',
  message: 'Disconnected',
  filesystemState: 'idle',
};

const QUICK_COMMANDS_STORAGE_KEY = 'ssh-studio.quick-commands.v1';

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
  const [isLoadingSavedConnections, setIsLoadingSavedConnections] = useState(true);
  const [activeSavedConnectionId, setActiveSavedConnectionId] = useState<string | null>(null);
  const [removingSavedConnectionId, setRemovingSavedConnectionId] = useState<string | null>(null);
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
  const [editorRevealTarget, setEditorRevealTarget] = useState<{ tabId: string; line: number; column: number } | null>(null);
  const autoSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const directoryLoadPromisesRef = useRef(new Map<string, Promise<boolean>>());
  const idlePrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkspacePathRef = useRef<string | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null);
  const treeContextMenuRef = useRef<HTMLDivElement | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
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

      if (payload.state === 'connected') {
        setCurrentConnectionId(payload.connectionId ?? null);
        setShowConnectionScreen(false);
      }

      if (payload.state === 'disconnected') {
        setCurrentConnectionId(null);
        setCurrentSavedConnectionId(null);
        setShowConnectionScreen(true);
        setEntryDialog(null);
        setFolderPickerInitialPath(null);
        setSavedConnectionRenameDialog(null);
        setSearchDialogOpen(false);
        setQuickCommandsDialogOpen(false);
      }
    });

    return unsubscribe;
  }, []);

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
  }, []);

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
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [saveActiveTab, showConnectionScreen]);

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

  async function connect(): Promise<void> {
    setBusyAction('connecting');
    setActiveSavedConnectionId(null);
    setStatusMessage(`Connecting to ${connectionForm.host}:${connectionForm.port}...`);

    try {
      const matchingSavedConnection = findMatchingSavedConnection(connectionForm);
      const result = await window.electronAPI.connect(connectionForm);
      setCurrentSavedConnectionId(result.savedConnectionId ?? null);
      setConnectionForm((previous) => ({ ...previous, password: '' }));
      void initializeRemoteState(result, matchingSavedConnection?.workspacePaths[0] ?? matchingSavedConnection?.lastWorkspacePath);
      void loadSavedConnections(true);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to connect'));
    } finally {
      setBusyAction(null);
    }
  }

  async function connectSaved(savedConnection: SavedConnectionSummary, preferredWorkspacePath?: string): Promise<void> {
    setBusyAction('connecting');
    setActiveSavedConnectionId(savedConnection.id);
    setStatusMessage(`Connecting to ${savedConnection.username}@${savedConnection.host}:${savedConnection.port}...`);

    try {
      const result = await window.electronAPI.connectSaved(savedConnection.id);
      setCurrentSavedConnectionId(result.savedConnectionId ?? savedConnection.id);
      void initializeRemoteState(
        result,
        preferredWorkspacePath ?? savedConnection.workspacePaths[0] ?? savedConnection.lastWorkspacePath,
      );
      void loadSavedConnections(true);
    } catch (error) {
      setStatusMessage(getErrorMessage(error, 'Unable to connect'));
    } finally {
      setBusyAction(null);
      setActiveSavedConnectionId(null);
    }
  }

  async function disconnect(): Promise<void> {
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
    } catch (error) {
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

    const loaded = await refreshDirectory(nextWorkspacePath, true);
    if (loaded || nextWorkspacePath === resolvedHomeDir) {
      return;
    }

    setWorkspacePath(resolvedHomeDir);
    setSelectedTreePath(resolvedHomeDir);
    setExpandedDirectories(new Set([resolvedHomeDir]));
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
      const file = await window.electronAPI.readFile(remotePath);
      const nextTab: EditorTabItem = {
        id: buildTabId(currentConnectionId, remotePath),
        connectionId: currentConnectionId,
        path: file.path,
        name: remotePath.split('/').pop() || remotePath,
        content: file.content,
        savedContent: file.content,
        isSaving: false,
        autosaveRevision: 0,
      };

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
    await window.electronAPI.deleteEntry({ path: entry.path });
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
    await window.electronAPI.uploadLocalEntries(remotePath);
    await refreshDirectory(remotePath, true);
    setStatusMessage(`Uploaded into ${remotePath}`);
  }

  async function downloadEntry(entry: RemoteDirectoryEntry): Promise<void> {
    await window.electronAPI.downloadEntry(entry.path);
    setStatusMessage(`Downloaded ${entry.path}`);
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
    (action: 'upload' | 'download' | 'rename' | 'delete' | 'create-file' | 'create-folder', path: string) => {
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
        void uploadToDirectory(entry.path);
        return;
      }

      if (action === 'download') {
        void downloadEntry(entry);
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
            <button
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
            </button>
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
          </div>

          <div className="menu-bar-center" title={workspacePath}>
            {isConnected ? workspaceName : 'No folder open'}
          </div>
        </div>

        <div className="status-cluster">
          <span className={`state-badge state-${connectionStatus.state}`}>{connectionStatus.state}</span>
          <span className="status-text">{statusMessage}</span>
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
              isLoadingSavedConnections={isLoadingSavedConnections}
              activeSavedConnectionId={activeSavedConnectionId}
              removingSavedConnectionId={removingSavedConnectionId}
              onChange={setConnectionForm}
              onConnect={() => {
                void connect();
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
              onDisconnect={() => {
                void disconnect();
              }}
            />
          </div>
        </main>
      ) : (
      <PanelGroup direction="vertical" className="app-panels">
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
                  {activeTab ? (
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
        <div className="statusbar-section">
          <span>{getFileSystemStatusText(connectionStatus.filesystemState)}</span>
        </div>
        <div className="statusbar-section">
          <span>{autoSaveEnabled ? 'Auto Save On' : 'Auto Save Off'}</span>
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
    </div>
  );
}
