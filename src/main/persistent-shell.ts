import type { PersistentShellKind, RemoteShellSessionSummary } from '../shared/contracts';

import { quoteForShell } from './shell';

/**
 * Terminals normally die with their SSH channel, which means a training run
 * started in one is lost the moment the laptop sleeps or the network blips.
 * When the remote host has tmux (or screen) we instead run the shell inside a
 * named multiplexer session, so the process keeps running after a disconnect
 * and the next terminal can re-attach to it.
 *
 * Everything in this module is pure string building/parsing so the command
 * shapes can be unit tested without a remote host.
 */

export const SESSION_NAME_PREFIX = 'sshstudio';

// Unit separator: session names may contain spaces, ':' or '.', so a control
// character is used to split the list output instead.
const TMUX_LIST_SEPARATOR = '\u0001';
const TMUX_LIST_FORMAT = [
  '#{session_name}',
  '#{session_windows}',
  '#{session_attached}',
  '#{session_created}',
].join(TMUX_LIST_SEPARATOR);

export function buildSupportProbeCommand(): string {
  return [
    'if command -v tmux >/dev/null 2>&1; then echo tmux;',
    'elif command -v screen >/dev/null 2>&1; then echo screen;',
    'else echo none; fi',
  ].join(' ');
}

export function parseSupportProbe(stdout: string): PersistentShellKind {
  const value = stdout.trim().split(/\s+/).pop() ?? '';
  if (value === 'tmux' || value === 'screen') {
    return value;
  }

  return 'none';
}

/**
 * Session names end up inside shell commands and tmux target specifiers, so
 * only a conservative character set is allowed. Anything else is replaced
 * rather than rejected, because names are often derived from workspace paths.
 */
export function normalizeSessionName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return cleaned === '' ? SESSION_NAME_PREFIX : cleaned;
}

export function buildSessionName(workspacePath: string, index: number): string {
  const leaf = workspacePath
    .split('/')
    .filter((segment) => segment !== '')
    .pop();

  const base = leaf ? `${SESSION_NAME_PREFIX}-${leaf}` : SESSION_NAME_PREFIX;
  return normalizeSessionName(index > 1 ? `${base}-${index}` : base);
}

export function buildListSessionsCommand(kind: PersistentShellKind): string | null {
  if (kind === 'tmux') {
    // `list-sessions` exits non-zero when no server is running, which is not an
    // error for us: an empty list is the correct answer.
    return `tmux list-sessions -F ${quoteForShell(TMUX_LIST_FORMAT)} 2>/dev/null || true`;
  }

  if (kind === 'screen') {
    return 'screen -ls 2>/dev/null || true';
  }

  return null;
}

export function parseSessionList(kind: PersistentShellKind, stdout: string): RemoteShellSessionSummary[] {
  if (kind === 'tmux') {
    return parseTmuxSessions(stdout);
  }

  if (kind === 'screen') {
    return parseScreenSessions(stdout);
  }

  return [];
}

function parseTmuxSessions(stdout: string): RemoteShellSessionSummary[] {
  const sessions: RemoteShellSessionSummary[] = [];

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const [name, windows, attached, created] = line.split(TMUX_LIST_SEPARATOR);
    if (!name) {
      continue;
    }

    sessions.push({
      name: name.trim(),
      windows: toPositiveInteger(windows),
      attached: (attached ?? '').trim() !== '0' && (attached ?? '').trim() !== '',
      createdAt: toPositiveInteger(created),
    });
  }

  return sessions;
}

/**
 * `screen -ls` prints lines like:
 *   `\t12345.sshstudio-runs\t(01/02/2026 10:11:12 AM)\t(Detached)`
 * Older builds omit the timestamp, so only the pid.name and the state are
 * treated as required.
 */
function parseScreenSessions(stdout: string): RemoteShellSessionSummary[] {
  const sessions: RemoteShellSessionSummary[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    const match = /^(\d+)\.(\S+)/.exec(line);
    if (!match) {
      continue;
    }

    sessions.push({
      name: `${match[1]}.${match[2]}`,
      attached: /\(attached\)/i.test(line),
    });
  }

  return sessions;
}

export interface PersistentShellCommandInput {
  kind: PersistentShellKind;
  sessionName: string;
  workspacePath?: string;
  /**
   * Environment exported to the attach command. A newly created session inherits
   * it (both tmux and screen copy the client environment), so vision mode's
   * DISPLAY can be set without typing into a session that may be running a job.
   */
  env?: Record<string, string>;
}

function buildEnvPrefix(env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {}).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (entries.length === 0) {
    return '';
  }

  return `${entries.map(([name, value]) => `${name}=${quoteForShell(value)}`).join(' ')} `;
}

/**
 * Sets a variable in a running tmux session's environment. It applies to panes
 * and windows created afterwards, not to the shell already running, which is
 * exactly what we want: no keystrokes are sent to a live job. screen has no
 * equivalent, so it returns null and the caller skips it.
 */
export function buildSetSessionEnvCommand(
  kind: PersistentShellKind,
  sessionName: string,
  name: string,
  value: string,
): string | null {
  if (kind !== 'tmux' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return null;
  }

  return `tmux setenv -t ${quoteForShell(normalizeSessionName(sessionName))} ${name} ${quoteForShell(value)}`;
}

/**
 * Builds the login-shell command that attaches to `sessionName`, creating it if
 * it does not exist yet. `tmux new-session -A` would be shorter but is not
 * available on the tmux 1.8 builds still shipped by older enterprise distros,
 * so an explicit `has-session` probe is used instead.
 */
export function buildAttachCommand({
  kind,
  sessionName,
  workspacePath,
  env,
}: PersistentShellCommandInput): string {
  const name = normalizeSessionName(sessionName);
  const quotedName = quoteForShell(name);
  const envPrefix = buildEnvPrefix(env);

  if (kind === 'tmux') {
    const createArgs = [`${envPrefix}tmux -u new-session -s ${quotedName}`];
    if (workspacePath && workspacePath.trim() !== '') {
      createArgs.push(`-c ${quoteForShell(workspacePath)}`);
    }

    return [
      `if tmux has-session -t ${quotedName} 2>/dev/null; then`,
      `exec ${envPrefix}tmux -u attach-session -t ${quotedName};`,
      'else',
      `exec ${createArgs.join(' ')};`,
      'fi',
    ].join(' ');
  }

  if (kind === 'screen') {
    // -xRR: attach to a running session (shared), reattach if detached, and
    // create one when nothing matches.
    const cd = workspacePath && workspacePath.trim() !== '' ? `cd ${quoteForShell(workspacePath)}; ` : '';
    return `${cd}exec ${envPrefix}screen -xRR -S ${quotedName}`;
  }

  throw new Error('No persistent shell multiplexer is available on the remote host');
}

export function buildKillSessionCommand(kind: PersistentShellKind, sessionName: string): string {
  const quotedName = quoteForShell(normalizeSessionName(sessionName));

  if (kind === 'tmux') {
    return `tmux kill-session -t ${quotedName}`;
  }

  if (kind === 'screen') {
    return `screen -S ${quotedName} -X quit`;
  }

  throw new Error('No persistent shell multiplexer is available on the remote host');
}

function toPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
