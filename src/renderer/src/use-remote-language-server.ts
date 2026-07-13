import { useEffect, useMemo, useRef, useState } from 'react';
import type * as MonacoEditor from 'monaco-editor';

import type {
  LanguageServerDiagnostic,
  LanguageServerDiagnosticsEvent,
  LanguageServerFeature,
  LanguageServerRange,
  LanguageServerStateEvent,
  LanguageServerStatus,
  StartLanguageServerResult,
} from '../../shared/contracts';
import type { EditorTabItem } from './components/EditorTabs';
import { monaco } from './monaco';

interface UseRemoteLanguageServerInput {
  connectionId: string | null;
  connected: boolean;
  workspacePath: string;
  tabs: EditorTabItem[];
  onOpenLocation: (remotePath: string, line: number, column: number) => Promise<void>;
}

export interface RemoteLanguageServerViewState {
  status: LanguageServerStatus;
  message: string;
}

interface ActiveSession {
  id: string;
  key: string;
  connectionId: string;
  workspacePath: string;
}

interface OpenDocument {
  model: MonacoEditor.editor.ITextModel;
  changeSubscription: MonacoEditor.IDisposable;
  savedContent: string;
}

interface LspMarkupContent {
  kind?: string;
  value: string;
}

interface LspTextEdit {
  range?: LanguageServerRange;
  newText?: string;
}

interface LspCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit;
}

interface LspCompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

interface LspHover {
  contents: string | LspMarkupContent | Array<string | LspMarkupContent>;
  range?: LanguageServerRange;
}

interface LspLocation {
  uri?: string;
  range?: LanguageServerRange;
  targetUri?: string;
  targetRange?: LanguageServerRange;
  targetSelectionRange?: LanguageServerRange;
}

const MARKER_OWNER = 'ssh-studio-remote-lsp';
const SUPPORTED_LANGUAGE_IDS = new Set(['typescript', 'javascript']);
const initialTypeScriptMode = { ...monaco.languages.typescript.typescriptDefaults.modeConfiguration };
const initialJavaScriptMode = { ...monaco.languages.typescript.javascriptDefaults.modeConfiguration };

function isSupportedLanguage(languageId: string): boolean {
  return SUPPORTED_LANGUAGE_IDS.has(languageId);
}

function getLanguageId(remotePath: string): string | null {
  const extension = remotePath.split('.').pop()?.toLowerCase();
  if (extension === 'ts' || extension === 'tsx') {
    return 'typescript';
  }
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') {
    return 'javascript';
  }
  return null;
}

export function buildRemoteModelUri(connectionId: string, remotePath: string): MonacoEditor.Uri {
  return monaco.Uri.parse(`ssh://${connectionId}${remotePath}`);
}

export function getRemotePathFromModelUri(uri: MonacoEditor.Uri, connectionId: string): string | null {
  if (uri.scheme !== 'ssh' || uri.authority !== connectionId || !uri.path.startsWith('/')) {
    return null;
  }
  return uri.path;
}

function toLspRange(range: MonacoEditor.IRange): LanguageServerRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

function toMonacoRange(range: LanguageServerRange): MonacoEditor.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function toMarkerSeverity(severity?: number): MonacoEditor.MarkerSeverity {
  if (severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  if (severity === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

function toMarker(diagnostic: LanguageServerDiagnostic): MonacoEditor.editor.IMarkerData {
  return {
    ...toMonacoRange(diagnostic.range),
    severity: toMarkerSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
  };
}

function toMarkdown(value: string | LspMarkupContent | undefined): MonacoEditor.IMarkdownString | undefined {
  if (typeof value === 'string') {
    return { value };
  }
  return value && typeof value.value === 'string' ? { value: value.value } : undefined;
}

function toCompletionKind(kind?: number): MonacoEditor.languages.CompletionItemKind {
  const normalized = Math.max(0, Math.min(27, (kind ?? 1) - 1));
  return normalized as MonacoEditor.languages.CompletionItemKind;
}

function normalizeCompletionResult(value: unknown): { items: LspCompletionItem[]; incomplete: boolean } {
  if (Array.isArray(value)) {
    return { items: value as LspCompletionItem[], incomplete: false };
  }
  if (value && typeof value === 'object' && Array.isArray((value as LspCompletionList).items)) {
    const list = value as LspCompletionList;
    return { items: list.items, incomplete: list.isIncomplete === true };
  }
  return { items: [], incomplete: false };
}

function remoteFileUriToModelUri(uri: string, connectionId: string): MonacoEditor.Uri | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' || parsed.hostname !== '') {
      return null;
    }
    return buildRemoteModelUri(connectionId, decodeURIComponent(parsed.pathname));
  } catch {
    return null;
  }
}

function setBuiltInTypeScriptFeaturesEnabled(enabled: boolean): void {
  const override = enabled
    ? {}
    : { completionItems: false, hovers: false, definitions: false, diagnostics: false };
  monaco.languages.typescript.typescriptDefaults.setModeConfiguration({ ...initialTypeScriptMode, ...override });
  monaco.languages.typescript.javascriptDefaults.setModeConfiguration({ ...initialJavaScriptMode, ...override });
}

export function useRemoteLanguageServer({
  connectionId,
  connected,
  workspacePath,
  tabs,
  onOpenLocation,
}: UseRemoteLanguageServerInput): RemoteLanguageServerViewState {
  const [viewState, setViewState] = useState<RemoteLanguageServerViewState>({
    status: 'stopped',
    message: 'Language server idle',
  });
  const activeSessionRef = useRef<ActiveSession | null>(null);
  const attemptedSessionKeyRef = useRef<string | null>(null);
  const stateSessionIdRef = useRef<string | null>(null);
  const openDocumentsRef = useRef(new Map<string, OpenDocument>());
  const diagnosticsRef = useRef(new Map<string, LanguageServerDiagnostic[]>());
  const documentQueueRef = useRef<Promise<void>>(Promise.resolve());
  const tabsRef = useRef(tabs);
  const openLocationRef = useRef(onOpenLocation);

  tabsRef.current = tabs;
  openLocationRef.current = onOpenLocation;

  const hasSupportedTab = useMemo(
    () => tabs.some((tab) => tab.connectionId === connectionId && getLanguageId(tab.path) !== null),
    [connectionId, tabs],
  );
  const desiredSessionKey = connected && connectionId && hasSupportedTab
    ? `${connectionId}:${workspacePath}:typescript`
    : null;

  function enqueueDocumentOperation(operation: () => Promise<void>): void {
    documentQueueRef.current = documentQueueRef.current.then(operation, operation).catch(() => undefined);
  }

  function clearOpenDocuments(): void {
    for (const document of openDocumentsRef.current.values()) {
      document.changeSubscription.dispose();
    }
    openDocumentsRef.current.clear();
  }

  function applyDiagnostics(remotePath: string): void {
    const session = activeSessionRef.current;
    if (!session) {
      return;
    }
    const model = monaco.editor.getModel(buildRemoteModelUri(session.connectionId, remotePath));
    if (model) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, (diagnosticsRef.current.get(remotePath) ?? []).map(toMarker));
    }
  }

  function attachModel(model: MonacoEditor.editor.ITextModel): void {
    const session = activeSessionRef.current;
    if (!session || !isSupportedLanguage(model.getLanguageId())) {
      return;
    }
    const remotePath = getRemotePathFromModelUri(model.uri, session.connectionId);
    if (!remotePath || openDocumentsRef.current.has(remotePath)) {
      return;
    }
    const tab = tabsRef.current.find((item) => item.connectionId === session.connectionId && item.path === remotePath);
    if (!tab) {
      return;
    }

    const sessionId = session.id;
    enqueueDocumentOperation(() =>
      window.electronAPI.openLanguageDocument({
        sessionId,
        remotePath,
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        text: model.getValue(),
      }),
    );
    const changeSubscription = model.onDidChangeContent((event) => {
      if (activeSessionRef.current?.id !== sessionId) {
        return;
      }
      enqueueDocumentOperation(() =>
        window.electronAPI.changeLanguageDocument({
          sessionId,
          remotePath,
          version: model.getVersionId(),
          contentChanges: event.changes.map((change) => ({
            range: toLspRange(change.range),
            rangeLength: change.rangeLength,
            text: change.text,
          })),
        }),
      );
    });
    openDocumentsRef.current.set(remotePath, { model, changeSubscription, savedContent: tab.savedContent });
    applyDiagnostics(remotePath);
  }

  function detachDocument(remotePath: string, notify: boolean): void {
    const document = openDocumentsRef.current.get(remotePath);
    if (!document) {
      return;
    }
    document.changeSubscription.dispose();
    openDocumentsRef.current.delete(remotePath);
    monaco.editor.setModelMarkers(document.model, MARKER_OWNER, []);
    const sessionId = activeSessionRef.current?.id;
    if (notify && sessionId) {
      enqueueDocumentOperation(() => window.electronAPI.closeLanguageDocument({ sessionId, remotePath }));
    }
  }

  async function requestFeature(
    feature: LanguageServerFeature,
    model: MonacoEditor.editor.ITextModel,
    position: MonacoEditor.Position,
  ): Promise<unknown> {
    const session = activeSessionRef.current;
    if (!session) {
      return null;
    }
    const remotePath = getRemotePathFromModelUri(model.uri, session.connectionId);
    if (!remotePath) {
      return null;
    }
    await documentQueueRef.current;
    return window.electronAPI.requestLanguageFeature({
      sessionId: session.id,
      remotePath,
      feature,
      position: { line: position.lineNumber - 1, character: position.column - 1 },
    });
  }

  useEffect(() => {
    const unsubscribeState = window.electronAPI.onLanguageServerState((event: LanguageServerStateEvent) => {
      if (event.workspacePath !== workspacePath || event.language !== 'typescript') {
        return;
      }
      if (event.status === 'starting') {
        stateSessionIdRef.current = event.sessionId ?? null;
      } else if (stateSessionIdRef.current && event.sessionId !== stateSessionIdRef.current) {
        return;
      }
      setViewState({ status: event.status, message: event.message });
      setBuiltInTypeScriptFeaturesEnabled(event.status !== 'ready');
      if (event.status === 'error' || event.status === 'unavailable' || event.status === 'stopped') {
        diagnosticsRef.current.clear();
        for (const document of openDocumentsRef.current.values()) {
          monaco.editor.setModelMarkers(document.model, MARKER_OWNER, []);
        }
      }
    });
    const unsubscribeDiagnostics = window.electronAPI.onLanguageServerDiagnostics((event: LanguageServerDiagnosticsEvent) => {
      if (event.sessionId !== activeSessionRef.current?.id) {
        return;
      }
      diagnosticsRef.current.set(event.remotePath, event.diagnostics);
      applyDiagnostics(event.remotePath);
    });
    return () => {
      unsubscribeState();
      unsubscribeDiagnostics();
    };
  }, [workspacePath]);

  useEffect(() => {
    let cancelled = false;
    const current = activeSessionRef.current;
    if (current?.key === desiredSessionKey) {
      return;
    }

    if (current) {
      activeSessionRef.current = null;
      clearOpenDocuments();
      diagnosticsRef.current.clear();
      setBuiltInTypeScriptFeaturesEnabled(true);
      void window.electronAPI.stopLanguageServer(current.id).catch(() => undefined);
    }

    if (!desiredSessionKey || !connectionId) {
      attemptedSessionKeyRef.current = null;
      stateSessionIdRef.current = null;
      setViewState({ status: 'stopped', message: 'Language server idle' });
      return;
    }
    if (attemptedSessionKeyRef.current === desiredSessionKey) {
      return;
    }
    attemptedSessionKeyRef.current = desiredSessionKey;
    setViewState({ status: 'starting', message: 'Starting remote TypeScript language server...' });

    void window.electronAPI
      .startLanguageServer({ workspacePath, language: 'typescript' })
      .then((result: StartLanguageServerResult) => {
        if (cancelled) {
          return window.electronAPI.stopLanguageServer(result.sessionId);
        }
        activeSessionRef.current = {
          id: result.sessionId,
          key: desiredSessionKey,
          connectionId,
          workspacePath,
        };
        setViewState({ status: 'ready', message: 'Remote TypeScript language server ready' });
        setBuiltInTypeScriptFeaturesEnabled(false);
        for (const model of monaco.editor.getModels()) {
          attachModel(model);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setViewState({
            status: 'unavailable',
            message: error instanceof Error ? error.message : 'Remote TypeScript language server unavailable',
          });
          setBuiltInTypeScriptFeaturesEnabled(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectionId, desiredSessionKey, workspacePath]);

  useEffect(() => {
    const created = monaco.editor.onDidCreateModel((model) => attachModel(model));
    const disposed = monaco.editor.onWillDisposeModel((model) => {
      const session = activeSessionRef.current;
      if (!session) return;
      const remotePath = getRemotePathFromModelUri(model.uri, session.connectionId);
      if (remotePath) detachDocument(remotePath, true);
    });
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selectionOrPosition) => {
        const session = activeSessionRef.current;
        if (!session) return false;
        const remotePath = getRemotePathFromModelUri(resource, session.connectionId);
        if (!remotePath) return false;
        const position = selectionOrPosition
          ? 'lineNumber' in selectionOrPosition
            ? selectionOrPosition
            : { lineNumber: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
          : { lineNumber: 1, column: 1 };
        await openLocationRef.current(remotePath, position.lineNumber, position.column);
        return true;
      },
    });

    const providerDisposables: MonacoEditor.IDisposable[] = [];
    for (const languageId of SUPPORTED_LANGUAGE_IDS) {
      providerDisposables.push(
        monaco.languages.registerCompletionItemProvider(languageId, {
          triggerCharacters: ['.', '"', "'", '/', '@', '<'],
          provideCompletionItems: async (model, position) => {
            const result = normalizeCompletionResult(await requestFeature('completion', model, position));
            const word = model.getWordUntilPosition(position);
            const defaultRange = {
              startLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: word.endColumn,
            };
            return {
              incomplete: result.incomplete,
              suggestions: result.items
                .filter((item) => typeof item?.label === 'string' || typeof item?.label?.label === 'string')
                .map((item) => {
                  const label = typeof item.label === 'string' ? item.label : item.label.label;
                  const textEdit = item.textEdit;
                  return {
                    label: typeof item.label === 'string' ? item.label : item.label,
                    kind: toCompletionKind(item.kind),
                    detail: item.detail,
                    documentation: toMarkdown(item.documentation),
                    sortText: item.sortText,
                    filterText: item.filterText,
                    insertText: textEdit?.newText ?? item.insertText ?? label,
                    insertTextRules:
                      item.insertTextFormat === 2
                        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                        : undefined,
                    range: textEdit?.range ? toMonacoRange(textEdit.range) : defaultRange,
                  } satisfies MonacoEditor.languages.CompletionItem;
                }),
            };
          },
        }),
        monaco.languages.registerHoverProvider(languageId, {
          provideHover: async (model, position) => {
            const value = (await requestFeature('hover', model, position)) as LspHover | null;
            if (!value?.contents) return null;
            const contents = (Array.isArray(value.contents) ? value.contents : [value.contents])
              .map((item) => toMarkdown(item))
              .filter((item): item is MonacoEditor.IMarkdownString => item !== undefined);
            return contents.length > 0
              ? { contents, range: value.range ? toMonacoRange(value.range) : undefined }
              : null;
          },
        }),
        monaco.languages.registerDefinitionProvider(languageId, {
          provideDefinition: async (model, position) => {
            const value = await requestFeature('definition', model, position);
            const locations = Array.isArray(value) ? (value as LspLocation[]) : value ? [value as LspLocation] : [];
            const session = activeSessionRef.current;
            if (!session) return [];
            return locations.flatMap((location) => {
              const uri = location.targetUri ?? location.uri;
              const range = location.targetSelectionRange ?? location.targetRange ?? location.range;
              const modelUri = uri ? remoteFileUriToModelUri(uri, session.connectionId) : null;
              return modelUri && range ? [{ uri: modelUri, range: toMonacoRange(range) }] : [];
            });
          },
        }),
      );
    }

    return () => {
      created.dispose();
      disposed.dispose();
      opener.dispose();
      providerDisposables.forEach((disposable) => disposable.dispose());
      setBuiltInTypeScriptFeaturesEnabled(true);
      clearOpenDocuments();
    };
  }, []);

  useEffect(() => {
    const session = activeSessionRef.current;
    if (!session) return;
    const currentPaths = new Set(
      tabs.filter((tab) => tab.connectionId === session.connectionId && getLanguageId(tab.path) !== null).map((tab) => tab.path),
    );
    for (const model of monaco.editor.getModels()) {
      attachModel(model);
    }
    for (const remotePath of [...openDocumentsRef.current.keys()]) {
      if (!currentPaths.has(remotePath)) detachDocument(remotePath, true);
    }
    for (const tab of tabs) {
      const document = openDocumentsRef.current.get(tab.path);
      if (!document || tab.connectionId !== session.connectionId || document.savedContent === tab.savedContent) continue;
      document.savedContent = tab.savedContent;
      enqueueDocumentOperation(() =>
        window.electronAPI.saveLanguageDocument({ sessionId: session.id, remotePath: tab.path }),
      );
    }
  }, [tabs]);

  useEffect(() => {
    return () => {
      const session = activeSessionRef.current;
      activeSessionRef.current = null;
      if (session) void window.electronAPI.stopLanguageServer(session.id).catch(() => undefined);
    };
  }, []);

  return viewState;
}
