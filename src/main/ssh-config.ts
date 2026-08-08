import path from 'node:path';

import type { ConnectInput } from '../shared/contracts';

export interface ImportedSshConnection extends ConnectInput { displayName: string }
interface SshOptions { hostName?: string; user?: string; port?: string; identityFile?: string; proxyJump?: string; userKnownHostsFile?: string }

function stripComment(line: string): string {
  let quoted = false; let escaped = false; let result = '';
  for (const character of line) {
    if (character === '"' && !escaped) quoted = !quoted;
    if (character === '#' && !quoted) break;
    result += character;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  return result.trim();
}

function parseDirective(line: string): [string, string] | null {
  const separator = line.search(/[\s=]/);
  if (separator === -1) return null;
  const key = line.slice(0, separator).trim().toLowerCase();
  const value = line.slice(separator).replace(/^\s*=\s*|^\s+/, '').trim().replace(/^"(.*)"$/, '$1');
  return key === '' || value === '' ? null : [key, value];
}

function expandHome(value: string, homeDirectory: string, host = '', username = ''): string {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory, value.slice(2));
  return value.replace(/%d/g, homeDirectory).replace(/%h/g, host).replace(/%r/g, username);
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
}

function parseProxyJump(value: string | undefined, username: string): ConnectInput['jumpHost'] {
  if (!value || value.includes(',') || value.toLowerCase() === 'none') return undefined;
  const match = /^(?:(?<user>[^@:\s]+)@)?(?<host>\[[^\]]+\]|[^:\s]+)(?::(?<port>\d+))?$/.exec(value);
  if (!match?.groups?.host) return undefined;
  return { host: match.groups.host.replace(/^\[|\]$/g, ''), port: parsePort(match.groups.port), username: match.groups.user ?? username, authMethod: 'agent', password: '', agentSocket: '' };
}

function buildInput(alias: string, options: SshOptions, defaultUsername: string, homeDirectory: string): ImportedSshConnection | null {
  const host = (options.hostName ?? alias).trim();
  const username = (options.user ?? defaultUsername).trim();
  if (host === '' || username === '') return null;
  const privateKeyPath = options.identityFile ? expandHome(options.identityFile.split(/\s+/)[0], homeDirectory, host, username) : '';
  const knownHostsPath = options.userKnownHostsFile ? expandHome(options.userKnownHostsFile.split(/\s+/)[0], homeDirectory, host, username) : '';
  return { displayName: alias, host, port: parsePort(options.port), username, authMethod: privateKeyPath === '' ? 'agent' : 'privateKey', password: '', privateKeyPath, passphrase: '', agentSocket: '', hostVerification: knownHostsPath === '' ? 'off' : 'knownHosts', knownHostsPath, jumpHost: parseProxyJump(options.proxyJump, username) };
}

export function parseSshConfig(config: string, defaultUsername: string, homeDirectory: string): ImportedSshConnection[] {
  const globalOptions: SshOptions = {};
  const hosts: Array<{ aliases: string[]; options: SshOptions }> = [];
  let current: SshOptions | null = globalOptions;
  for (const rawLine of config.split(/\r?\n/)) {
    const directive = parseDirective(stripComment(rawLine));
    if (!directive) continue;
    const [key, value] = directive;
    if (key === 'match') { current = null; continue; }
    if (key === 'host') {
      const aliases = value.split(/\s+/).filter((alias) => !/[*!?]/.test(alias));
      current = aliases.length > 0 ? { ...globalOptions } : null;
      if (current) hosts.push({ aliases, options: current });
      continue;
    }
    if (!current || !['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'userknownhostsfile'].includes(key)) continue;
    const optionKey = ({ hostname: 'hostName', user: 'user', port: 'port', identityfile: 'identityFile', proxyjump: 'proxyJump', userknownhostsfile: 'userKnownHostsFile' } as Record<string, keyof SshOptions>)[key];
    if (current[optionKey] === undefined) current[optionKey] = value;
  }
  const imported = new Map<string, ImportedSshConnection>();
  for (const entry of hosts) for (const alias of entry.aliases) { const input = buildInput(alias, entry.options, defaultUsername, homeDirectory); if (input) imported.set(alias, input); }
  return [...imported.values()];
}
