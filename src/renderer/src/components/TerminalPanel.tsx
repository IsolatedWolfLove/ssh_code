import { Columns2, MonitorCog, Plus, X } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Fragment, memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import type { ConnectionStatePayload, TerminalEvent } from '../../../shared/contracts';

interface TerminalPanelProps {
  connectionStatus: ConnectionStatePayload;
  workspacePath: string;
  onStatusMessage: (message: string) => void;
}

interface TerminalSessionItem {
  id: string;
  label: string;
}

type TerminalSinkSource = 'live' | 'replay';
type TerminalSink = (event: TerminalEvent, source: TerminalSinkSource) => void;

interface RegisteredTerminalSink {
  deliveredCount: number;
  sink: TerminalSink;
}

const MAX_REPLAY_EVENTS_PER_TERMINAL = 2000;

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

function TerminalInstance({
  active,
  onActivate,
  onStatusMessage,
  registerSink,
  sessionId,
}: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const readyRef = useRef(true);
  const terminalRef = useRef<Terminal | null>(null);
  const [ready, setReady] = useState(true);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "JetBrains Mono", monospace',
      fontSize: 13,
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
        terminalRef.current.write(event.data);
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

      unregisterSink();
      terminalDataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onStatusMessage, registerSink, sessionId]);

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

export const TerminalPanel = memo(function TerminalPanel({
  connectionStatus,
  workspacePath,
  onStatusMessage,
}: TerminalPanelProps) {
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'creating' | 'splitting' | null>(null);
  const [terminals, setTerminals] = useState<TerminalSessionItem[]>([]);
  const [visibleTerminalIds, setVisibleTerminalIds] = useState<string[]>([]);
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
      setActiveTerminalId(null);
      setBusyAction(null);
      setTerminals([]);
      setVisibleTerminalIds([]);
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
    setActiveTerminalId(null);
    setTerminals([]);
    setVisibleTerminalIds([]);
    void openTerminal('new', true);
  }, [connectionStatus.connectionId, connectionStatus.state]);

  useEffect(() => {
    if (connectionStatus.state !== 'connected' || workspacePath.trim() === '') {
      return;
    }

    for (const terminal of terminals) {
      if (terminalStatesRef.current.get(terminal.id) !== 'open') {
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

  async function openTerminal(mode: 'new' | 'split', silent = false): Promise<void> {
    if (connectionStatus.state !== 'connected' || !connectionStatus.connectionId) {
      onStatusMessage('Connect before opening a terminal');
      return;
    }

    const expectedConnectionId = connectionStatus.connectionId;
    setBusyAction(mode === 'split' ? 'splitting' : 'creating');

    try {
      const result = await window.electronAPI.createTerminal();
      if (connectionIdRef.current !== expectedConnectionId) {
        ignoredTerminalIdsRef.current.add(result.terminalId);
        void window.electronAPI.closeTerminal(result.terminalId).catch(() => {
          // Ignore stale terminal cleanup failures after a reconnect.
        });
        return;
      }

      const label = `Terminal ${nextTerminalNumberRef.current}`;
      nextTerminalNumberRef.current += 1;
      const nextTerminal = {
        id: result.terminalId,
        label,
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
    } catch (error) {
      onStatusMessage(getErrorMessage(error, 'Unable to start terminal'));
    } finally {
      setBusyAction(null);
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

  return (
    <section className="terminal-panel">
      <div className="terminal-header">
        <div className="section-heading">
          <span>Terminal</span>
          <span className="terminal-caption">
            <MonitorCog size={14} />
            {isConnected ? `${terminals.length} shell${terminals.length === 1 ? '' : 's'}` : 'Waiting for connection'}
          </span>
        </div>

        <div className="terminal-toolbar">
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
                  title={terminal.label}
                  onClick={() => {
                    revealTerminal(terminal.id);
                  }}
                >
                  <span className="terminal-tab-name">{terminal.label}</span>
                  {isVisible && visibleTerminalIds.length > 1 ? (
                    <span className="terminal-tab-badge">Split</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  title={`Close ${terminal.label}`}
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
});
