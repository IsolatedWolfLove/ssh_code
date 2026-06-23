import { PencilLine, Play, PlugZap, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { SavedTunnelConfig, TunnelKind, TunnelSnapshot } from '../../../shared/contracts';

interface TunnelDraft {
  id: string;
  name: string;
  kind: TunnelKind;
  localHost: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
  targetHost: string;
  targetPort: string;
}

interface TunnelsDialogProps {
  tunnels: TunnelSnapshot[];
  isConnected: boolean;
  isLoading: boolean;
  isSaving: boolean;
  busyTunnelIds: Set<string>;
  workspacePath: string;
  onSaveTunnel: (tunnel: SavedTunnelConfig) => Promise<void>;
  onDeleteTunnel: (tunnelId: string) => Promise<void>;
  onStartTunnel: (tunnelId: string) => Promise<void>;
  onStopTunnel: (tunnelId: string) => Promise<void>;
  onClose: () => void;
}

function createTunnelId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEmptyDraft(kind: TunnelKind = 'local'): TunnelDraft {
  return {
    id: createTunnelId(),
    name: '',
    kind,
    localHost: '127.0.0.1',
    localPort: kind === 'dynamic' ? '1080' : '3000',
    remoteHost: '127.0.0.1',
    remotePort: '3000',
    targetHost: '127.0.0.1',
    targetPort: '3000',
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }

  return fallback;
}

function getTunnelSummary(tunnel: SavedTunnelConfig): string {
  if (tunnel.kind === 'dynamic') {
    return `${tunnel.localHost}:${tunnel.localPort} -> SOCKS5 proxy`;
  }

  if (tunnel.kind === 'local') {
    return `${tunnel.localHost}:${tunnel.localPort} -> ${tunnel.targetHost}:${tunnel.targetPort}`;
  }

  return `remote ${tunnel.remoteHost}:${tunnel.remotePort} -> ${tunnel.targetHost}:${tunnel.targetPort}`;
}

function toDraft(tunnel: SavedTunnelConfig): TunnelDraft {
  if (tunnel.kind === 'dynamic') {
    return {
      id: tunnel.id,
      name: tunnel.name,
      kind: tunnel.kind,
      localHost: tunnel.localHost,
      localPort: String(tunnel.localPort),
      remoteHost: '127.0.0.1',
      remotePort: '3000',
      targetHost: '127.0.0.1',
      targetPort: '3000',
    };
  }

  if (tunnel.kind === 'local') {
    return {
      id: tunnel.id,
      name: tunnel.name,
      kind: tunnel.kind,
      localHost: tunnel.localHost,
      localPort: String(tunnel.localPort),
      remoteHost: '127.0.0.1',
      remotePort: '3000',
      targetHost: tunnel.targetHost,
      targetPort: String(tunnel.targetPort),
    };
  }

  return {
    id: tunnel.id,
    name: tunnel.name,
    kind: tunnel.kind,
    localHost: '127.0.0.1',
    localPort: '3000',
    remoteHost: tunnel.remoteHost,
    remotePort: String(tunnel.remotePort),
    targetHost: tunnel.targetHost,
    targetPort: String(tunnel.targetPort),
  };
}

function parsePort(value: string, field: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be between 1 and 65535`);
  }

  return port;
}

function buildTunnelConfig(draft: TunnelDraft): SavedTunnelConfig {
  const name = draft.name.trim();
  if (name === '') {
    throw new Error('Tunnel name is required');
  }

  if (draft.kind === 'dynamic') {
    const localHost = draft.localHost.trim();
    if (localHost === '') {
      throw new Error('Local host is required');
    }

    return {
      id: draft.id,
      name,
      kind: 'dynamic',
      localHost,
      localPort: parsePort(draft.localPort, 'Local port'),
    };
  }

  const targetHost = draft.targetHost.trim();
  if (targetHost === '') {
    throw new Error('Target host is required');
  }

  if (draft.kind === 'local') {
    const localHost = draft.localHost.trim();
    if (localHost === '') {
      throw new Error('Local host is required');
    }

    return {
      id: draft.id,
      name,
      kind: 'local',
      localHost,
      localPort: parsePort(draft.localPort, 'Local port'),
      targetHost,
      targetPort: parsePort(draft.targetPort, 'Target port'),
    };
  }

  const remoteHost = draft.remoteHost.trim();
  if (remoteHost === '') {
    throw new Error('Remote host is required');
  }

  return {
    id: draft.id,
    name,
    kind: 'remote',
    remoteHost,
    remotePort: parsePort(draft.remotePort, 'Remote port'),
    targetHost,
    targetPort: parsePort(draft.targetPort, 'Target port'),
  };
}

export function TunnelsDialog({
  tunnels,
  isConnected,
  isLoading,
  isSaving,
  busyTunnelIds,
  workspacePath,
  onSaveTunnel,
  onDeleteTunnel,
  onStartTunnel,
  onStopTunnel,
  onClose,
}: TunnelsDialogProps) {
  const titleId = useId();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<TunnelDraft>(() => createEmptyDraft());
  const [editingTunnelId, setEditingTunnelId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [onClose]);

  async function submitTunnel(): Promise<void> {
    try {
      const nextTunnel = buildTunnelConfig(draft);
      await onSaveTunnel(nextTunnel);
      setDraft(createEmptyDraft(draft.kind));
      setEditingTunnelId(null);
      setFormError('');
    } catch (error) {
      setFormError(getErrorMessage(error, 'Unable to save tunnel'));
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="dialog-card tunnels-dialog-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header">
          <div>
            <h2 id={titleId}>Tunnels</h2>
            <p>{workspacePath}</p>
          </div>
          <button
            type="button"
            className="icon-button dialog-close-button"
            aria-label="Close tunnels"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="tunnel-list">
          {isLoading ? (
            <div className="quick-command-empty">
              <PlugZap size={20} />
              <span>Loading tunnels...</span>
            </div>
          ) : tunnels.length > 0 ? (
            tunnels.map((snapshot) => {
              const busy = busyTunnelIds.has(snapshot.config.id);
              const running = snapshot.state.status === 'running' || snapshot.state.status === 'starting';

              return (
                <div key={snapshot.config.id} className="tunnel-row">
                  <div className="tunnel-copy">
                    <div className="tunnel-copy-main">
                      <strong>{snapshot.config.name}</strong>
                      <span className={`tunnel-state-badge tunnel-state-${snapshot.state.status}`}>
                        {snapshot.state.status}
                      </span>
                    </div>
                    <span>{getTunnelSummary(snapshot.config)}</span>
                    {snapshot.state.message ? <span>{snapshot.state.message}</span> : null}
                  </div>

                  <div className="tunnel-actions">
                    <button
                      type="button"
                      className="icon-button tunnel-action-button"
                      title={running ? `Stop ${snapshot.config.name}` : `Start ${snapshot.config.name}`}
                      disabled={!isConnected || busy}
                      onClick={() => {
                        if (running) {
                          void onStopTunnel(snapshot.config.id);
                        } else {
                          void onStartTunnel(snapshot.config.id);
                        }
                      }}
                    >
                      {running ? <Square size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      type="button"
                      className="icon-button tunnel-action-button"
                      title={`Edit ${snapshot.config.name}`}
                      disabled={busy || isSaving}
                      onClick={() => {
                        setDraft(toDraft(snapshot.config));
                        setEditingTunnelId(snapshot.config.id);
                        setFormError('');
                        nameInputRef.current?.focus();
                      }}
                    >
                      <PencilLine size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button tunnel-action-button tunnel-action-danger"
                      title={`Delete ${snapshot.config.name}`}
                      disabled={busy || isSaving}
                      onClick={() => {
                        void onDeleteTunnel(snapshot.config.id);
                        if (editingTunnelId === snapshot.config.id) {
                          setEditingTunnelId(null);
                          setDraft(createEmptyDraft(draft.kind));
                          setFormError('');
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="quick-command-empty">
              <PlugZap size={20} />
              <span>No tunnels yet</span>
            </div>
          )}
        </div>

        <div className="tunnel-form">
          <div className="auth-choice-row tunnel-kind-row">
            {(['local', 'remote', 'dynamic'] as TunnelKind[]).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`auth-choice-button ${draft.kind === kind ? 'auth-choice-button-active' : ''}`}
                onClick={() => {
                  setDraft((previous) => ({
                    ...previous,
                    kind,
                    localPort: kind === 'dynamic' && previous.localPort === '3000' ? '1080' : previous.localPort,
                  }));
                }}
              >
                <span>{kind}</span>
              </button>
            ))}
          </div>

          <div className="tunnel-form-grid">
            <label className="dialog-field">
              <span>Name</span>
              <input
                ref={nameInputRef}
                value={draft.name}
                onChange={(event) => {
                  setDraft((previous) => ({ ...previous, name: event.target.value }));
                }}
                placeholder="mysql staging"
              />
            </label>

            {draft.kind !== 'remote' ? (
              <>
                <label className="dialog-field">
                  <span>Local Host</span>
                  <input
                    value={draft.localHost}
                    onChange={(event) => {
                      setDraft((previous) => ({ ...previous, localHost: event.target.value }));
                    }}
                    placeholder="127.0.0.1"
                  />
                </label>
                <label className="dialog-field">
                  <span>Local Port</span>
                  <input
                    value={draft.localPort}
                    inputMode="numeric"
                    onChange={(event) => {
                      setDraft((previous) => ({ ...previous, localPort: event.target.value }));
                    }}
                    placeholder="3000"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="dialog-field">
                  <span>Remote Host</span>
                  <input
                    value={draft.remoteHost}
                    onChange={(event) => {
                      setDraft((previous) => ({ ...previous, remoteHost: event.target.value }));
                    }}
                    placeholder="127.0.0.1"
                  />
                </label>
                <label className="dialog-field">
                  <span>Remote Port</span>
                  <input
                    value={draft.remotePort}
                    inputMode="numeric"
                    onChange={(event) => {
                      setDraft((previous) => ({ ...previous, remotePort: event.target.value }));
                    }}
                    placeholder="3000"
                  />
                </label>
              </>
            )}

            {draft.kind !== 'dynamic' ? (
              <>
                <label className="dialog-field">
                  <span>Target Host</span>
                  <input
                    value={draft.targetHost}
                    onChange={(event) => {
                      setDraft((previous) => ({ ...previous, targetHost: event.target.value }));
                    }}
                    placeholder="127.0.0.1"
                  />
                </label>
                <label className="dialog-field">
                  <span>Target Port</span>
                  <input
                    value={draft.targetPort}
                    inputMode="numeric"
                    onChange={(event) => {
                      setDraft((previous) => ({ ...previous, targetPort: event.target.value }));
                    }}
                    placeholder="3306"
                  />
                </label>
              </>
            ) : null}
          </div>

          {formError ? <div className="tunnel-form-error">{formError}</div> : null}

          <div className="tunnel-form-actions">
            {editingTunnelId ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditingTunnelId(null);
                  setDraft(createEmptyDraft(draft.kind));
                  setFormError('');
                }}
              >
                <span>Cancel Edit</span>
              </button>
            ) : null}
            <button
              type="button"
              className="primary-button quick-command-add"
              disabled={isSaving}
              onClick={() => {
                void submitTunnel();
              }}
            >
              {editingTunnelId ? <PencilLine size={16} /> : <Plus size={16} />}
              <span>{editingTunnelId ? 'Save Tunnel' : 'Add Tunnel'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
