import {
  ChevronDown,
  ChevronRight,
  History,
  LoaderCircle,
  LogIn,
  PencilLine,
  PlugZap,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { type ChangeEvent, useState } from 'react';

import type {
  ConnectInput,
  ConnectionStatePayload,
  SavedConnectionSummary,
} from '../../../shared/contracts';

interface ConnectionFormProps {
  value: ConnectInput;
  status: ConnectionStatePayload;
  isBusy: boolean;
  mode?: 'launch' | 'compact';
  savedConnections?: SavedConnectionSummary[];
  isLoadingSavedConnections?: boolean;
  activeSavedConnectionId?: string | null;
  removingSavedConnectionId?: string | null;
  onChange: (next: ConnectInput) => void;
  onConnect: () => void;
  onConnectSaved?: (savedConnectionId: string) => void;
  onConnectSavedWorkspace?: (savedConnectionId: string, workspacePath: string) => void;
  onRemoveSaved?: (savedConnectionId: string) => void;
  onRenameSaved?: (savedConnectionId: string) => void;
  onDisconnect: () => void;
}

function formatLastConnectedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

export function ConnectionForm({
  value,
  status,
  isBusy,
  mode = 'compact',
  savedConnections = [],
  isLoadingSavedConnections = false,
  activeSavedConnectionId = null,
  removingSavedConnectionId = null,
  onChange,
  onConnect,
  onConnectSaved,
  onConnectSavedWorkspace,
  onRemoveSaved,
  onRenameSaved,
  onDisconnect,
}: ConnectionFormProps) {
  const [expandedSavedConnectionIds, setExpandedSavedConnectionIds] = useState<Set<string>>(new Set());

  function handleField<K extends keyof ConnectInput>(key: K) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const rawValue = event.target.value;
      onChange({
        ...value,
        [key]: key === 'port' ? Number(rawValue) || 22 : rawValue,
      });
    };
  }

  const connected = status.state === 'connected';
  const actionLabel = connected ? 'Reconnect' : 'Connect';
  const ActionIcon = connected ? RefreshCw : PlugZap;

  function toggleSavedConnectionWorkspaces(savedConnectionId: string): void {
    setExpandedSavedConnectionIds((previous) => {
      const next = new Set(previous);
      if (next.has(savedConnectionId)) {
        next.delete(savedConnectionId);
      } else {
        next.add(savedConnectionId);
      }
      return next;
    });
  }

  return (
    <section className={`connection-form connection-form-${mode}`}>
      <div className="section-heading">
        <span>Connection</span>
        <span className={`state-badge state-${status.state}`}>{status.state}</span>
      </div>

      {mode === 'launch' ? (
        <div className="connection-copy">
          <h1>Open a remote workspace</h1>
          <p>Connect once, then work in files and terminal without keeping the login form on screen.</p>
        </div>
      ) : null}

      <label>
        <span>Host</span>
        <input value={value.host} onChange={handleField('host')} placeholder="10.0.0.23" />
      </label>

      <div className="field-row">
        <label>
          <span>Port</span>
          <input value={String(value.port)} onChange={handleField('port')} inputMode="numeric" />
        </label>

        <label>
          <span>User</span>
          <input value={value.username} onChange={handleField('username')} placeholder="root" />
        </label>
      </div>

      <label>
        <span>Password</span>
        <input
          type="password"
          value={value.password}
          onChange={handleField('password')}
          placeholder="SSH password"
        />
      </label>

      <div className="connection-actions">
        <button
          type="button"
          className="primary-button"
          onClick={onConnect}
          disabled={isBusy || value.host.trim() === '' || value.username.trim() === '' || value.password === ''}
        >
          {isBusy ? <LoaderCircle className="spin" size={16} /> : <ActionIcon size={16} />}
          <span>{actionLabel}</span>
        </button>

        {mode === 'compact' ? (
          <button type="button" className="secondary-button" onClick={onDisconnect} disabled={isBusy || !connected}>
            <Power size={16} />
            <span>Disconnect</span>
          </button>
        ) : null}
      </div>

      {mode === 'launch' ? (
        <section className="saved-connections">
          <div className="section-heading">
            <span>Recent Clients</span>
            <History size={14} />
          </div>

          {isLoadingSavedConnections ? (
            <div className="saved-connections-empty">
              <LoaderCircle className="spin" size={16} />
              <span>Loading recent clients...</span>
            </div>
          ) : savedConnections.length > 0 ? (
            <div className="saved-connections-list">
              {savedConnections.map((savedConnection) => {
                const isConnectingSaved = activeSavedConnectionId === savedConnection.id;
                const isRemovingSaved = removingSavedConnectionId === savedConnection.id;
                const workspacesExpanded = expandedSavedConnectionIds.has(savedConnection.id);
                const primaryLabel = savedConnection.displayName;
                const secondaryLabel =
                  savedConnection.displayName === `${savedConnection.username}@${savedConnection.host}`
                    ? `${savedConnection.host}:${savedConnection.port}`
                    : `${savedConnection.username}@${savedConnection.host}:${savedConnection.port}`;

                return (
                  <div key={savedConnection.id} className="saved-connection-card">
                    <div className="saved-connection-main">
                      <button
                        type="button"
                        className="saved-connection-button"
                        disabled={isBusy || isRemovingSaved}
                        onClick={() => {
                          onConnectSaved?.(savedConnection.id);
                        }}
                      >
                        <div className="saved-connection-copy">
                          <strong>{primaryLabel}</strong>
                          <span>{secondaryLabel}</span>
                          <span>Last connected {formatLastConnectedAt(savedConnection.lastConnectedAt)}</span>
                        </div>
                        <span className="saved-connection-button-label">
                          {isConnectingSaved ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                          <span>{isConnectingSaved ? 'Connecting' : 'Connect'}</span>
                        </span>
                      </button>

                      {savedConnection.workspacePaths.length > 0 ? (
                        <div className="saved-workspace-panel">
                          <button
                            type="button"
                            className="saved-workspace-toggle"
                            disabled={isBusy || isRemovingSaved}
                            onClick={() => {
                              toggleSavedConnectionWorkspaces(savedConnection.id);
                            }}
                          >
                            {workspacesExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span>Workspaces</span>
                            <strong>{savedConnection.workspacePaths.length}</strong>
                          </button>

                          {workspacesExpanded ? (
                            <div className="saved-workspace-list">
                              {savedConnection.workspacePaths.map((workspacePath, index) => (
                                <button
                                  key={workspacePath}
                                  type="button"
                                  className="saved-workspace-chip"
                                  disabled={isBusy || isRemovingSaved}
                                  onClick={() => {
                                    onConnectSavedWorkspace?.(savedConnection.id, workspacePath);
                                  }}
                                  title={workspacePath}
                                >
                                  <span>{index === 0 ? 'Recent' : 'Workspace'}</span>
                                  <strong>{workspacePath}</strong>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div className="saved-connection-actions">
                      <button
                        type="button"
                        className="icon-button saved-connection-action"
                        disabled={isBusy || isRemovingSaved}
                        aria-label={`Rename ${savedConnection.displayName}`}
                        onClick={() => {
                          onRenameSaved?.(savedConnection.id);
                        }}
                      >
                        <PencilLine size={16} />
                      </button>

                      <button
                        type="button"
                        className="icon-button saved-connection-action saved-connection-remove"
                        disabled={isBusy || isRemovingSaved}
                        aria-label={`Remove ${savedConnection.displayName}`}
                        onClick={() => {
                          onRemoveSaved?.(savedConnection.id);
                        }}
                      >
                        {isRemovingSaved ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="saved-connections-empty">
              <span>Your successful SSH connections will show up here for one-click access.</span>
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}
