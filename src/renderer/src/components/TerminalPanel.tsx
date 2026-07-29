import { Columns2, Link2, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ForwardedRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import type {
  ConnectionStatePayload,
  PersistentShellKind,
  RemoteShellSessionSummary,
  TerminalEvent,
} from '../../../shared/contracts';
import { getScaledFontSize, useWindowFontScale } from '../window-font-scale';

interface TerminalPanelProps {
  connectionStatus: ConnectionStatePayload;
  workspacePath: string;
  onStatusMessage: (message: string) => void;
}

export interface TerminalPanelHandle {
  runCommand: (command: string, label?: string) => Promise<void>;
}

interface TerminalSessionItem {
  id: string;
  label: string;
  /** Set when this shell runs inside a tmux/screen session on the remote host. */
  sessionName?: string;
}

type TerminalSinkSource = 'live' | 'replay';
type TerminalSink = (event: TerminalEvent, source: TerminalSinkSource) => void;

interface RegisteredTerminalSink {
  deliveredCount: number;
  sink: TerminalSink;
}

const MAX_REPLAY_EVENTS_PER_TERMINAL = 2000;
const SESSION_NAME_PREFIX = 'sshstudio';

function buildSessionName(workspacePath: string, index: number): string {
  const leaf = workspacePath
    .split('/')
    .filter((segment) => segment !== '')
    .pop();
  const base = leaf ? `${SESSION_NAME_PREFIX}-${leaf}` : SESSION_NAME_PREFIX;
  return index > 1 ? `${base}-${index}` : base;
}

function describeSession(session: RemoteShellSessionSummary): string {
  const parts: string[] = [];
  if (session.windows !== undefined) {
    parts.push(`${session.windows} window${session.windows === 1 ? '' : 's'}`);
  }
  parts.push(session.attached ? 'attached' : 'detached');
  return parts.join(' · ');
}

interface TerminalInstanceProps {
  active: boolean;
  onActivate: () => void;
  onStatusMessage: (message: string) => void;
  registerSink: (terminalId: string, sink: TerminalSink) => () => void;
  sessionId: string;
}

function shellEscape(remotePath: string): string {
  return `'${remotePath.replace(/'/g, `'\\''`)}'`;
}

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) {
      return false;
    }

    seen.add(id);
    return true;
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function appendReplayEvent(replayLog: TerminalEvent[], event: TerminalEvent): void {
  replayLog.push(event);

  if (replayLog.length > MAX_REPLAY_EVENTS_PER_TERMINAL) {
    replayLog.splice(0, replayLog.length - MAX_REPLAY_EVENTS_PER_TERMINAL);
  }
}

function shouldUseTextInputEvent(event: KeyboardEvent): boolean {
  return (
    event.type === 'keydown' &&
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing
  );
}

function TerminalInstance({
  active,
  onActivate,
  onStatusMessage,
  registerSink,
  sessionId,
}: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fontScale = useWindowFontScale();
  const readyRef = useRef(true);
  const terminalRef = useRef<Terminal | null>(null);
  const pendingWriteRef = useRef('');
  const pendingWriteFrameRef = useRef<number | null>(null);
  const [ready, setReady] = useState(true);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "JetBrains Mono", monospace',
      fontSize: getScaledFontSize(13),
      theme: {
        background: '#0b1017',
        foreground: '#dbe7f2',
        cursor: '#37d2c8',
        black: '#10151d',
        brightBlack: '#576273',
      },
      convertEol: true,
      scrollback: 6000,
    });

    terminal.attachCustomKeyEventHandler((event) => {
      // Avoid sending printable keys from both keydown and text-input events in Electron.
      if (shouldUseTextInputEvent(event)) {
        return false;
      }

      return true;
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    readyRef.current = true;
    setReady(true);

    const target = containerRef.current;
    if (target) {
      terminal.open(target);
    }

    let resizeFrame: number | null = null;
    const fitAndResize = () => {
      fitAddon.fit();
      if (readyRef.current) {
        void window.electronAPI.resizeTerminal(sessionId, terminal.cols, terminal.rows);
      }
    };
    const scheduleFitAndResize = () => {
      if (resizeFrame !== null) {
        return;
      }

      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAndResize();
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleFitAndResize();
    });

    if (target) {
      resizeObserver.observe(target);
    }

    const terminalDataDisposable = terminal.onData((value) => {
      if (!readyRef.current) {
        return;
      }

      void window.electronAPI.writeTerminal(sessionId, value);
    });

    const unregisterSink = registerSink(sessionId, (event, source) => {
      if (!terminalRef.current) {
        return;
      }

      if (event.type === 'data') {
        pendingWriteRef.current += event.data;
        if (pendingWriteFrameRef.current === null) {
          pendingWriteFrameRef.current = window.requestAnimationFrame(() => {
            pendingWriteFrameRef.current = null;
            const output = pendingWriteRef.current;
            pendingWriteRef.current = '';
            if (output !== '') {
              terminalRef.current?.write(output);
            }
          });
        }
        return;
      }

      if (event.type === 'error') {
        terminalRef.current.writeln(`\r\n[terminal] ${event.message}`);
        if (source === 'live') {
          onStatusMessage(event.message);
        }
        return;
      }

      terminalRef.current.writeln('\r\n[terminal] session ended');
      readyRef.current = false;
      setReady(false);
    });

    scheduleFitAndResize();

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (pendingWriteFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingWriteFrameRef.current);
      }

      unregisterSink();
      terminalDataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onStatusMessage, registerSink, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    terminal.options.fontSize = getScaledFontSize(13, fontScale);
    fitAddon.fit();

    if (readyRef.current) {
      void window.electronAPI.resizeTerminal(sessionId, terminal.cols, terminal.rows);
    }
  }, [fontScale, sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    terminalRef.current?.focus();
    fitAddonRef.current?.fit();

    if (readyRef.current && terminalRef.current) {
      void window.electronAPI.resizeTerminal(sessionId, terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [active, sessionId]);

  return (
    <div
      className={`terminal-instance ${active ? 'terminal-instance-active' : ''}`}
      onMouseDown={onActivate}
    >
      <div className="terminal-surface" ref={containerRef} />
      {!ready ? <div className="terminal-pane-status">Session ended</div> : null}
    </div>
  );
}

function TerminalPanelComponent({
  connectionStatus,
  workspacePath,
  onStatusMessage,
}: TerminalPanelProps, ref: ForwardedRef<TerminalPanelHandle>) {
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'creating' | 'splitting' | null>(null);
  const [terminals, setTerminals] = useState<TerminalSessionItem[]>([]);
  const [visibleTerminalIds, setVisibleTerminalIds] = useState<string[]>([]);
  const [persistentKind, setPersistentKind] = useState<PersistentShellKind>('none');
  const [remoteSessions, setRemoteSessions] = useState<RemoteShellSessionSummary[]>([]);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const persistentKindRef = useRef<PersistentShellKind>('none');
  const sessionPickerRef = useRef<HTMLDivElement | null>(null);
  const activeTerminalIdRef = useRef<string | null>(null);
  const bootstrappedConnectionIdRef = useRef<string | null>(null);
  const connectionIdRef = useRef<string | null>(connectionStatus.connectionId ?? null);
  const ignoredTerminalIdsRef = useRef(new Set<string>());
  const nextTerminalNumberRef = useRef(1);
  const replayLogRef = useRef(new Map<string, TerminalEvent[]>());
  const syncedPathsRef = useRef(new Map<string, string | null>());
  const terminalStatesRef = useRef(new Map<string, 'open' | 'closed'>());
  const terminalSinksRef = useRef(new Map<string, RegisteredTerminalSink>());
  const terminalsRef = useRef<TerminalSessionItem[]>([]);
  const visibleTerminalIdsRef = useRef<string[]>([]);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  useEffect(() => {
    visibleTerminalIdsRef.current = visibleTerminalIds;
  }, [visibleTerminalIds]);

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId;
  }, [activeTerminalId]);

  useEffect(() => {
    connectionIdRef.current = connectionStatus.connectionId ?? null;
  }, [connectionStatus.connectionId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onTerminalEvent((event: TerminalEvent) => {
      if (ignoredTerminalIdsRef.current.has(event.terminalId)) {
        return;
      }

      const replayLog = replayLogRef.current.get(event.terminalId) ?? [];
      appendReplayEvent(replayLog, event);
      replayLogRef.current.set(event.terminalId, replayLog);
      if (event.type === 'exit') {
        terminalStatesRef.current.set(event.terminalId, 'closed');
      }

      const sinkState = terminalSinksRef.current.get(event.terminalId);
      if (!sinkState) {
        return;
      }

      sinkState.deliveredCount += 1;
      sinkState.sink(event, 'live');
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const connectionId = connectionStatus.connectionId ?? null;
    if (connectionStatus.state !== 'connected' || !connectionId) {
      bootstrappedConnectionIdRef.current = null;
      ignoredTerminalIdsRef.current.clear();
      nextTerminalNumberRef.current = 1;
      replayLogRef.current.clear();
      syncedPathsRef.current.clear();
      terminalStatesRef.current.clear();
      terminalSinksRef.current.clear();
      persistentKindRef.current = 'none';
      setActiveTerminalId(null);
      setBusyAction(null);
      setTerminals([]);
      setVisibleTerminalIds([]);
      setPersistentKind('none');
      setRemoteSessions([]);
      setSessionPickerOpen(false);
      return;
    }

    if (bootstrappedConnectionIdRef.current === connectionId) {
      return;
    }

    bootstrappedConnectionIdRef.current = connectionId;
    ignoredTerminalIdsRef.current.clear();
    nextTerminalNumberRef.current = 1;
    replayLogRef.current.clear();
    syncedPathsRef.current.clear();
    terminalStatesRef.current.clear();
    terminalSinksRef.current.clear();
    persistentKindRef.current = 'none';
    setActiveTerminalId(null);
    setTerminals([]);
    setVisibleTerminalIds([]);
    setPersistentKind('none');
    setRemoteSessions([]);
    setSessionPickerOpen(false);

    // Probe once per connection so the toolbar can show whether new shells will
    // survive a disconnect, and so a reconnect can offer the sessions that are
    // still running from before.
    let cancelled = false;
    void window.electronAPI
      .getRemoteShellSupport()
      .then((support) => {
        if (cancelled || connectionIdRef.current !== connectionId) {
          return;
        }

        persistentKindRef.current = support.kind;
        setPersistentKind(support.kind);
        setRemoteSessions(support.sessions);
      })
      .catch(() => {
        // A failed probe just means shells stay non-persistent.
      });

    return () => {
      cancelled = true;
    };
  }, [connectionStatus.connectionId, connectionStatus.state]);

  useEffect(() => {
    if (connectionStatus.state !== 'connected' || workspacePath.trim() === '') {
      return;
    }

    for (const terminal of terminals) {
      if (terminalStatesRef.current.get(terminal.id) !== 'open') {
        continue;
      }

      // Persistent sessions may be running a long job rather than sitting at a
      // prompt, so a `cd` would be typed straight into that program's stdin.
      // Their working directory is set once when the session is created instead.
      if (terminal.sessionName) {
        continue;
      }

      if (syncedPathsRef.current.get(terminal.id) === workspacePath) {
        continue;
      }

      syncedPathsRef.current.set(terminal.id, workspacePath);
      void window.electronAPI.writeTerminal(terminal.id, `cd -- ${shellEscape(workspacePath)}\n`).catch(() => {
        syncedPathsRef.current.set(terminal.id, null);
      });
    }
  }, [connectionStatus.state, terminals, workspacePath]);

  useEffect(() => {
    if (!sessionPickerOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent): void {
      if (!sessionPickerRef.current?.contains(event.target as Node)) {
        setSessionPickerOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [sessionPickerOpen]);

  const registerSink = useCallback((terminalId: string, sink: TerminalSink): (() => void) => {
    const replayLog = replayLogRef.current.get(terminalId) ?? [];
    const sinkState: RegisteredTerminalSink = {
      deliveredCount: 0,
      sink,
    };

    terminalSinksRef.current.set(terminalId, sinkState);

    for (const event of replayLog) {
      sink(event, 'replay');
      sinkState.deliveredCount += 1;
    }

    return () => {
      const current = terminalSinksRef.current.get(terminalId);
      if (current?.sink === sink) {
        terminalSinksRef.current.delete(terminalId);
      }
    };
  }, []);

  function removeTerminalFromState(terminalId: string): void {
    const remainingTerminals = terminalsRef.current.filter((terminal) => terminal.id !== terminalId);
    const remainingVisibleIds = visibleTerminalIdsRef.current.filter((id) => id !== terminalId);
    const nextVisibleIds =
      remainingVisibleIds.length > 0
        ? remainingVisibleIds
        : remainingTerminals.length > 0
          ? [remainingTerminals[remainingTerminals.length - 1].id]
          : [];
    const nextActiveId =
      activeTerminalIdRef.current === terminalId
        ? nextVisibleIds[0] ?? remainingTerminals[remainingTerminals.length - 1]?.id ?? null
        : activeTerminalIdRef.current;

    replayLogRef.current.delete(terminalId);
    syncedPathsRef.current.delete(terminalId);
    terminalStatesRef.current.delete(terminalId);
    terminalSinksRef.current.delete(terminalId);
    ignoredTerminalIdsRef.current.add(terminalId);
    terminalsRef.current = remainingTerminals;
    visibleTerminalIdsRef.current = nextVisibleIds;
    activeTerminalIdRef.current = nextActiveId;

    setTerminals(remainingTerminals);
    setVisibleTerminalIds(nextVisibleIds);
    setActiveTerminalId(nextActiveId);
  }

  /**
   * Picks a session name that is not already running on the host. Reusing a name
   * would silently attach to someone else's (or a previous run's) session, and
   * anything typed afterwards would land in whatever program it is running.
   */
  function buildUnusedSessionName(): string {
    const taken = new Set<string>([
      ...remoteSessions.map((session) => session.name),
      ...terminalsRef.current.map((terminal) => terminal.sessionName ?? ''),
    ]);

    for (let index = 1; index <= 200; index += 1) {
      const candidate = buildSessionName(workspacePath, index);
      if (!taken.has(candidate)) {
        return candidate;
      }
    }

    return `${buildSessionName(workspacePath, 1)}-${Date.now()}`;
  }

  async function openTerminal(mode: 'new' | 'split', silent = false, labelOverride?: string): Promise<string | null> {
    if (connectionStatus.state !== 'connected' || !connectionStatus.connectionId) {
      onStatusMessage('Connect before opening a terminal');
      return null;
    }

    const expectedConnectionId = connectionStatus.connectionId;
    setBusyAction(mode === 'split' ? 'splitting' : 'creating');

    try {
      const result = await window.electronAPI.createTerminal(
        persistentKindRef.current === 'none'
          ? undefined
          : { sessionName: buildUnusedSessionName(), workspacePath },
      );
      if (connectionIdRef.current !== expectedConnectionId) {
        ignoredTerminalIdsRef.current.add(result.terminalId);
        void window.electronAPI.closeTerminal(result.terminalId).catch(() => {
          // Ignore stale terminal cleanup failures after a reconnect.
        });
        return null;
      }

      const normalizedLabel = labelOverride?.trim();
      const label = normalizedLabel ? normalizedLabel.slice(0, 48) : `Terminal ${nextTerminalNumberRef.current}`;
      nextTerminalNumberRef.current += 1;
      const nextTerminal: TerminalSessionItem = {
        id: result.terminalId,
        label,
        sessionName: result.sessionName,
      };

      replayLogRef.current.set(result.terminalId, replayLogRef.current.get(result.terminalId) ?? []);
      syncedPathsRef.current.set(result.terminalId, null);
      terminalStatesRef.current.set(result.terminalId, 'open');

      setTerminals((previous) => {
        const next = [...previous, nextTerminal];
        terminalsRef.current = next;
        return next;
      });
      setVisibleTerminalIds((previous) => {
        const next =
          mode === 'split' && previous.length > 0
            ? dedupeIds([...previous, result.terminalId])
            : [result.terminalId];
        visibleTerminalIdsRef.current = next;
        return next;
      });
      setActiveTerminalId(result.terminalId);
      activeTerminalIdRef.current = result.terminalId;

      if (!silent) {
        onStatusMessage(`Opened ${label}`);
      }
      return result.terminalId;
    } catch (error) {
      onStatusMessage(getErrorMessage(error, 'Unable to start terminal'));
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      async runCommand(command: string, label?: string): Promise<void> {
        const normalizedCommand = command.trim();
        if (normalizedCommand === '') {
          onStatusMessage('Command is empty');
          return;
        }

        const terminalId = await openTerminal('new', true, label);
        if (!terminalId) {
          return;
        }

        const normalizedWorkspacePath = workspacePath.trim();
        const commandText =
          normalizedWorkspacePath === ''
            ? `${normalizedCommand}\n`
            : `cd -- ${shellEscape(normalizedWorkspacePath)}\n${normalizedCommand}\n`;

        if (normalizedWorkspacePath !== '') {
          syncedPathsRef.current.set(terminalId, normalizedWorkspacePath);
        }

        try {
          await window.electronAPI.writeTerminal(terminalId, commandText);
          onStatusMessage(`Running ${label?.trim() || normalizedCommand}`);
        } catch (error) {
          onStatusMessage(getErrorMessage(error, 'Unable to run command'));
        }
      },
    }),
    [connectionStatus.connectionId, connectionStatus.state, onStatusMessage, workspacePath],
  );

  async function refreshRemoteSessions(): Promise<void> {
    if (connectionStatus.state !== 'connected') {
      return;
    }

    setSessionsLoading(true);
    try {
      const support = await window.electronAPI.getRemoteShellSupport();
      persistentKindRef.current = support.kind;
      setPersistentKind(support.kind);
      setRemoteSessions(support.sessions);
    } catch (error) {
      onStatusMessage(getErrorMessage(error, 'Unable to list remote sessions'));
    } finally {
      setSessionsLoading(false);
    }
  }

  /**
   * Re-attaches to a session that is already running on the host, e.g. a training
   * run started before the last disconnect.
   */
  async function attachRemoteSession(session: RemoteShellSessionSummary): Promise<void> {
    const existing = terminalsRef.current.find((terminal) => terminal.sessionName === session.name);
    if (existing) {
      revealTerminal(existing.id);
      setSessionPickerOpen(false);
      return;
    }

    if (connectionStatus.state !== 'connected' || !connectionStatus.connectionId) {
      onStatusMessage('Connect before attaching to a session');
      return;
    }

    const expectedConnectionId = connectionStatus.connectionId;
    setBusyAction('creating');

    try {
      const result = await window.electronAPI.createTerminal({ sessionName: session.name });
      if (connectionIdRef.current !== expectedConnectionId) {
        ignoredTerminalIdsRef.current.add(result.terminalId);
        void window.electronAPI.closeTerminal(result.terminalId).catch(() => {
          // Ignore stale terminal cleanup failures after a reconnect.
        });
        return;
      }

      const nextTerminal: TerminalSessionItem = {
        id: result.terminalId,
        label: session.name,
        sessionName: result.sessionName ?? session.name,
      };
      nextTerminalNumberRef.current += 1;

      replayLogRef.current.set(result.terminalId, replayLogRef.current.get(result.terminalId) ?? []);
      syncedPathsRef.current.set(result.terminalId, null);
      terminalStatesRef.current.set(result.terminalId, 'open');

      setTerminals((previous) => {
        const next = [...previous, nextTerminal];
        terminalsRef.current = next;
        return next;
      });
      setVisibleTerminalIds(() => {
        const next = [result.terminalId];
        visibleTerminalIdsRef.current = next;
        return next;
      });
      setActiveTerminalId(result.terminalId);
      activeTerminalIdRef.current = result.terminalId;
      setSessionPickerOpen(false);
      onStatusMessage(`Attached to ${session.name}`);
    } catch (error) {
      onStatusMessage(getErrorMessage(error, `Unable to attach to ${session.name}`));
    } finally {
      setBusyAction(null);
    }
  }

  /**
   * Ends a persistent session on the host, killing whatever it is running. The
   * local tab is closed first so its channel does not report the kill as an
   * unexpected session error.
   */
  async function killRemoteSession(session: RemoteShellSessionSummary): Promise<void> {
    const attachedTerminal = terminalsRef.current.find((terminal) => terminal.sessionName === session.name);
    if (attachedTerminal) {
      await closeTerminal(attachedTerminal.id);
    }

    try {
      await window.electronAPI.killRemoteShellSession(session.name);
      setRemoteSessions((previous) => previous.filter((item) => item.name !== session.name));
      onStatusMessage(`Ended session ${session.name}`);
    } catch (error) {
      onStatusMessage(getErrorMessage(error, `Unable to end session ${session.name}`));
    }
  }

  async function closeTerminal(terminalId: string): Promise<void> {
    const terminal = terminalsRef.current.find((item) => item.id === terminalId);
    if (!terminal) {
      return;
    }

    removeTerminalFromState(terminalId);

    try {
      await window.electronAPI.closeTerminal(terminalId);
      onStatusMessage(`Closed ${terminal.label}`);
    } catch (error) {
      onStatusMessage(getErrorMessage(error, `Unable to close ${terminal.label}`));
    }
  }

  function revealTerminal(terminalId: string): void {
    setActiveTerminalId(terminalId);
    activeTerminalIdRef.current = terminalId;

    setVisibleTerminalIds((previous) => {
      const next = previous.includes(terminalId) ? previous : [terminalId];
      visibleTerminalIdsRef.current = next;
      return next;
    });
  }

  const isConnected = connectionStatus.state === 'connected';
  const visibleTerminals = visibleTerminalIds
    .map((terminalId) => terminals.find((terminal) => terminal.id === terminalId) ?? null)
    .filter((terminal): terminal is TerminalSessionItem => terminal !== null);
  const attachedSessionNames = new Set(
    terminals.map((terminal) => terminal.sessionName).filter((name): name is string => name !== undefined),
  );

  return (
    <section className="terminal-panel">
      <div className="terminal-bar">
        <div className="terminal-summary">
          <span>Terminal</span>
          <span>
            {isConnected ? `${terminals.length} shell${terminals.length === 1 ? '' : 's'}` : 'Waiting for connection'}
          </span>
          {isConnected ? (
            <span
              className={`terminal-persist-badge terminal-persist-${persistentKind === 'none' ? 'off' : 'on'}`}
              title={
                persistentKind === 'none'
                  ? 'Neither tmux nor screen is installed on the remote host, so shells end when the connection drops. Install tmux to keep long jobs running.'
                  : `Shells run inside ${persistentKind} sessions and keep running after a disconnect`
              }
            >
              {persistentKind === 'none' ? 'not persistent' : persistentKind}
            </span>
          ) : null}
        </div>

        {terminals.length > 0 ? (
          <div className="terminal-tab-strip">
            {terminals.map((terminal) => {
              const isActive = terminal.id === activeTerminalId;
              const isVisible = visibleTerminalIds.includes(terminal.id);

              return (
                <div
                  key={terminal.id}
                  className={`terminal-tab ${isActive ? 'terminal-tab-active' : ''} ${isVisible ? 'terminal-tab-visible' : ''}`}
                >
                  <button
                    type="button"
                    className="terminal-tab-main"
                    title={terminal.sessionName ? `${terminal.label} · ${terminal.sessionName}` : terminal.label}
                    onClick={() => {
                      revealTerminal(terminal.id);
                    }}
                  >
                    {terminal.sessionName ? (
                      <Link2 className="terminal-tab-persist-icon" size={11} />
                    ) : null}
                    <span className="terminal-tab-name">{terminal.label}</span>
                    {isVisible && visibleTerminalIds.length > 1 ? (
                      <span className="terminal-tab-badge">Split</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="terminal-tab-close"
                    title={
                      terminal.sessionName
                        ? `Detach from ${terminal.sessionName} (keeps running on the host)`
                        : `Close ${terminal.label}`
                    }
                    onClick={() => {
                      void closeTerminal(terminal.id);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="terminal-toolbar">
          {persistentKind !== 'none' ? (
            <div className="terminal-session-menu" ref={sessionPickerRef}>
              <button
                type="button"
                className={`icon-button terminal-toolbar-button${sessionPickerOpen ? ' terminal-toolbar-button-open' : ''}`}
                title="Remote sessions: re-attach to a shell that is still running on the host"
                disabled={!isConnected || busyAction !== null}
                onClick={() => {
                  const nextOpen = !sessionPickerOpen;
                  setSessionPickerOpen(nextOpen);
                  if (nextOpen) {
                    void refreshRemoteSessions();
                  }
                }}
              >
                <Link2 size={14} />
              </button>

              {sessionPickerOpen ? (
                <div className="terminal-session-dropdown">
                  <div className="terminal-session-dropdown-header">
                    <span>Remote {persistentKind} sessions</span>
                    <button
                      type="button"
                      className="icon-button"
                      title="Refresh"
                      disabled={sessionsLoading}
                      onClick={() => {
                        void refreshRemoteSessions();
                      }}
                    >
                      <RefreshCw className={sessionsLoading ? 'spin' : ''} size={13} />
                    </button>
                  </div>

                  {remoteSessions.length === 0 ? (
                    <p className="terminal-session-empty">
                      {sessionsLoading ? 'Loading sessions' : 'No sessions running on this host'}
                    </p>
                  ) : (
                    <ul className="terminal-session-list">
                      {remoteSessions.map((session) => {
                        const attachedHere = attachedSessionNames.has(session.name);

                        return (
                          <li key={session.name} className="terminal-session-item">
                            <button
                              type="button"
                              className="terminal-session-attach"
                              title={attachedHere ? 'Show this session' : `Attach to ${session.name}`}
                              disabled={busyAction !== null}
                              onClick={() => {
                                void attachRemoteSession(session);
                              }}
                            >
                              <span className="terminal-session-name">{session.name}</span>
                              <span className="terminal-session-meta">
                                {attachedHere ? 'open here' : describeSession(session)}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="terminal-session-kill"
                              title={`End ${session.name} and stop whatever it is running`}
                              onClick={() => {
                                void killRemoteSession(session);
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="icon-button terminal-toolbar-button"
            title="New Terminal"
            disabled={!isConnected || busyAction !== null}
            onClick={() => {
              void openTerminal('new');
            }}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="icon-button terminal-toolbar-button"
            title="Split Terminal"
            disabled={!isConnected || busyAction !== null || terminals.length === 0}
            onClick={() => {
              void openTerminal('split');
            }}
          >
            <Columns2 size={14} />
          </button>
        </div>
      </div>

      {visibleTerminals.length === 0 ? (
        <div className="terminal-empty">
          <p>No terminal session</p>
          <button
            type="button"
            className="secondary-button terminal-empty-button"
            disabled={!isConnected || busyAction !== null}
            onClick={() => {
              void openTerminal('new');
            }}
          >
            <Plus size={14} />
            <span>New Terminal</span>
          </button>
        </div>
      ) : visibleTerminals.length === 1 ? (
        <div className="terminal-pane-shell">
          <TerminalInstance
            key={visibleTerminals[0].id}
            active={visibleTerminals[0].id === activeTerminalId}
            onActivate={() => {
              setActiveTerminalId(visibleTerminals[0].id);
              activeTerminalIdRef.current = visibleTerminals[0].id;
            }}
            onStatusMessage={onStatusMessage}
            registerSink={registerSink}
            sessionId={visibleTerminals[0].id}
          />
        </div>
      ) : (
        <PanelGroup direction="horizontal" className="terminal-split-group">
          {visibleTerminals.map((terminal, index) => (
            <Fragment key={terminal.id}>
              <Panel defaultSize={100 / visibleTerminals.length} minSize={18}>
                <div className="terminal-pane-shell">
                  <TerminalInstance
                    active={terminal.id === activeTerminalId}
                    onActivate={() => {
                      setActiveTerminalId(terminal.id);
                      activeTerminalIdRef.current = terminal.id;
                    }}
                    onStatusMessage={onStatusMessage}
                    registerSink={registerSink}
                    sessionId={terminal.id}
                  />
                </div>
              </Panel>

              {index < visibleTerminals.length - 1 ? (
                <PanelResizeHandle className="panel-handle panel-handle-vertical" />
              ) : null}
            </Fragment>
          ))}
        </PanelGroup>
      )}
    </section>
  );
}

export const TerminalPanel = memo(forwardRef<TerminalPanelHandle, TerminalPanelProps>(TerminalPanelComponent));
