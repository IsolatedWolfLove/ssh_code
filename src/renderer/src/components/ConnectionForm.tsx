import {
  ChevronDown,
  ChevronRight,
  Globe,
  KeyRound,
  History,
  LoaderCircle,
  LogIn,
  PencilLine,
  PlugZap,
  Power,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { type ChangeEvent, useState } from 'react';

import type {
  ConnectInput,
  ConnectionStatePayload,
  SavedConnectionSummary,
  TailscaleHostSummary,
} from '../../../shared/contracts';

interface ConnectionFormProps {
  value: ConnectInput;
  status: ConnectionStatePayload;
  isBusy: boolean;
  mode?: 'launch' | 'compact';
  savedConnections?: SavedConnectionSummary[];
  tailscaleHosts?: TailscaleHostSummary[];
  isLoadingTailscaleHosts?: boolean;
  isLoadingSavedConnections?: boolean;
  activeSavedConnectionId?: string | null;
  removingSavedConnectionId?: string | null;
  onChange: (next: ConnectInput) => void;
  onConnect: () => void;
  onConnectTailscaleHost?: (host: TailscaleHostSummary) => void;
  onRefreshTailscaleHosts?: () => void;
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
  tailscaleHosts = [],
  isLoadingTailscaleHosts = false,
  isLoadingSavedConnections = false,
  activeSavedConnectionId = null,
  removingSavedConnectionId = null,
  onChange,
  onConnect,
  onConnectTailscaleHost,
  onRefreshTailscaleHosts,
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
  const authMethod = value.authMethod ?? 'password';
  const hostVerification = value.hostVerification ?? 'off';

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

      <div className="auth-choice-row">
        <button
          type="button"
          className={`auth-choice-button ${authMethod === 'password' ? 'auth-choice-button-active' : ''}`}
          onClick={() => {
            onChange({ ...value, authMethod: 'password' });
          }}
        >
          <PlugZap size={14} />
          <span>Password</span>
        </button>
        <button
          type="button"
          className={`auth-choice-button ${authMethod === 'privateKey' ? 'auth-choice-button-active' : ''}`}
          onClick={() => {
            onChange({ ...value, authMethod: 'privateKey' });
          }}
        >
          <KeyRound size={14} />
          <span>SSH Key</span>
        </button>
        <button
          type="button"
          className={`auth-choice-button ${authMethod === 'agent' ? 'auth-choice-button-active' : ''}`}
          onClick={() => {
            onChange({ ...value, authMethod: 'agent' });
          }}
        >
          <ScanSearch size={14} />
          <span>Agent</span>
        </button>
        <button
          type="button"
          className={`auth-choice-button ${authMethod === 'tailscale' ? 'auth-choice-button-active' : ''}`}
          onClick={() => {
            onChange({
              ...value,
              authMethod: 'tailscale',
              hostVerification: 'off',
            });
          }}
        >
          <ShieldCheck size={14} />
          <span>Tailscale</span>
        </button>
      </div>

      {authMethod !== 'tailscale' ? (
        <>
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
        </>
      ) : (
        <div className="tailscale-mode-panel">
          <div className="tailscale-inline-hint">
            <ShieldCheck size={14} />
            <span>Pick a host below. The app will use your local Tailscale SSH user and connect immediately.</span>
          </div>
        </div>
      )}

      {authMethod === 'password' ? (
        <label>
          <span>Password</span>
          <input
            type="password"
            value={value.password}
            onChange={handleField('password')}
            placeholder="SSH password"
          />
        </label>
      ) : null}

      {authMethod === 'privateKey' ? (
        <>
          <label>
            <span>Private Key</span>
            <input
              value={value.privateKeyPath ?? ''}
              onChange={handleField('privateKeyPath')}
              placeholder="Path to private key file"
            />
          </label>
          <label>
            <span>Passphrase</span>
            <input
              type="password"
              value={value.passphrase ?? ''}
              onChange={handleField('passphrase')}
              placeholder="Optional key passphrase"
            />
          </label>
        </>
      ) : null}

      {authMethod === 'agent' ? (
        <label>
          <span>Agent Socket</span>
          <input
            value={value.agentSocket ?? ''}
            onChange={handleField('agentSocket')}
            placeholder="Path to SSH agent socket or pipe"
          />
        </label>
      ) : null}

      {authMethod !== 'tailscale' ? (
        <>
          <label className="toggle-row connection-toggle-row">
            <input
              type="checkbox"
              checked={hostVerification === 'knownHosts'}
              onChange={(event) => {
                onChange({
                  ...value,
                  hostVerification: event.target.checked ? 'knownHosts' : 'off',
                });
              }}
            />
            <span>Verify host with known_hosts</span>
          </label>

          {hostVerification === 'knownHosts' ? (
            <label>
              <span>known_hosts Path</span>
              <input
                value={value.knownHostsPath ?? ''}
                onChange={handleField('knownHostsPath')}
                placeholder="Path to known_hosts file"
              />
            </label>
          ) : null}
        </>
      ) : null}

      <div className="connection-actions">
        <button
          type="button"
          className="primary-button"
          onClick={onConnect}
          disabled={
            isBusy ||
            (authMethod !== 'tailscale' && value.host.trim() === '') ||
            (authMethod !== 'tailscale' && value.username.trim() === '') ||
            (authMethod === 'password' && value.password === '') ||
            (authMethod === 'privateKey' && (value.privateKeyPath ?? '').trim() === '') ||
            (authMethod === 'agent' && (value.agentSocket ?? '').trim() === '') ||
            (authMethod !== 'tailscale' &&
              hostVerification === 'knownHosts' &&
              (value.knownHostsPath ?? '').trim() === '')
          }
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
        <>
          {authMethod === 'tailscale' ? (
            <section className="saved-connections">
              <div className="section-heading">
                <span>Tailscale Hosts</span>
                <button
                  type="button"
                  className="icon-button saved-connection-action"
                  onClick={() => {
                    onRefreshTailscaleHosts?.();
                  }}
                  disabled={isBusy || isLoadingTailscaleHosts}
                  aria-label="Refresh Tailscale hosts"
                >
                  {isLoadingTailscaleHosts ? <LoaderCircle className="spin" size={16} /> : <Globe size={16} />}
                </button>
              </div>

              {isLoadingTailscaleHosts ? (
                <div className="saved-connections-empty">
                  <LoaderCircle className="spin" size={16} />
                  <span>Loading Tailscale hosts...</span>
                </div>
              ) : tailscaleHosts.length > 0 ? (
                <div className="saved-connections-list">
                  {tailscaleHosts.map((host) => (
                    <div key={host.id} className="saved-connection-card">
                      <div className="saved-connection-main">
                        <button
                          type="button"
                          className="saved-connection-button"
                          disabled={isBusy || !host.online}
                          onClick={() => {
                            onConnectTailscaleHost?.(host);
                          }}
                        >
                          <div className="saved-connection-copy">
                            <strong>{host.displayName}</strong>
                            <span>{host.host}</span>
                            <span>
                              {host.online ? 'Online' : 'Offline'}
                              {host.active ? ' • Active' : ''}
                              {host.os ? ` • ${host.os}` : ''}
                              {host.sshUser ? ` • ${host.sshUser}` : ''}
                            </span>
                          </div>
                          <span className="saved-connection-button-label">
                            <ShieldCheck size={16} />
                            <span>{host.online ? 'Connect' : 'Offline'}</span>
                          </span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="saved-connections-empty">
                  <span>No Tailscale hosts found. Make sure `tailscaled` is running and you are logged in.</span>
                </div>
              )}
            </section>
          ) : null}

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
        </>
      ) : null}
    </section>
  );
}
