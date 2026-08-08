import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { safeStorage } from 'electron';

import type { ConnectInput, JumpHostInput, SavedConnectionSummary, SavedTunnelConfig } from '../shared/contracts';
import type { ImportedSshConnection } from './ssh-config';

const SAVED_CONNECTIONS_FILE = 'saved-connections.json';
const MAX_SAVED_CONNECTIONS = 12;
const MAX_WORKSPACE_PATHS = 6;

type PasswordEncoding = 'safeStorage' | 'plain';
type OptionalSecretEncoding = PasswordEncoding | 'none';

interface StoredJumpHost {
  host: string;
  port: number;
  username: string;
  authMethod: JumpHostInput['authMethod'];
  password: string;
  passwordEncoding: OptionalSecretEncoding;
  privateKeyPath?: string;
  passphrase?: string;
  passphraseEncoding?: OptionalSecretEncoding;
  agentSocket?: string;
}

interface StoredSavedConnection {
  id: string;
  displayName?: string;
  host: string;
  port: number;
  username: string;
  authMethod?: NonNullable<ConnectInput['authMethod']>;
  password: string;
  passwordEncoding: OptionalSecretEncoding;
  privateKeyPath?: string;
  passphrase?: string;
  passphraseEncoding?: OptionalSecretEncoding;
  agentSocket?: string;
  hostVerification?: NonNullable<ConnectInput['hostVerification']>;
  knownHostsPath?: string;
  jumpHost?: StoredJumpHost;
  lastConnectedAt: string;
  lastWorkspacePath?: string;
  workspacePaths?: string[];
  tunnels?: SavedTunnelConfig[];
}

interface SavedConnectionsFile {
  version: 1;
  connections: StoredSavedConnection[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPasswordEncoding(value: unknown): value is PasswordEncoding {
  return value === 'safeStorage' || value === 'plain';
}

function isOptionalSecretEncoding(value: unknown): value is OptionalSecretEncoding {
  return value === 'none' || isPasswordEncoding(value);
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isStoredJumpHost(value: unknown): value is StoredJumpHost {
  return (
    isObject(value) &&
    typeof value.host === 'string' &&
    isPort(value.port) &&
    typeof value.username === 'string' &&
    (value.authMethod === 'password' || value.authMethod === 'privateKey' || value.authMethod === 'agent') &&
    typeof value.password === 'string' &&
    isOptionalSecretEncoding(value.passwordEncoding) &&
    (value.privateKeyPath === undefined || typeof value.privateKeyPath === 'string') &&
    (value.passphrase === undefined || typeof value.passphrase === 'string') &&
    (value.passphraseEncoding === undefined || isOptionalSecretEncoding(value.passphraseEncoding)) &&
    (value.agentSocket === undefined || typeof value.agentSocket === 'string')
  );
}

function isSavedTunnelConfig(value: unknown): value is SavedTunnelConfig {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.kind !== 'string') {
    return false;
  }

  if (value.kind === 'dynamic') {
    return typeof value.localHost === 'string' && isPort(value.localPort);
  }

  if (value.kind === 'local') {
    return (
      typeof value.localHost === 'string' &&
      isPort(value.localPort) &&
      typeof value.targetHost === 'string' &&
      isPort(value.targetPort)
    );
  }

  if (value.kind === 'remote') {
    return (
      typeof value.remoteHost === 'string' &&
      isPort(value.remotePort) &&
      typeof value.targetHost === 'string' &&
      isPort(value.targetPort)
    );
  }

  return false;
}

function normalizeTunnelConfig(config: SavedTunnelConfig): SavedTunnelConfig | null {
  const id = config.id.trim();
  const name = config.name.trim();
  if (id === '' || name === '') {
    return null;
  }

  if (config.kind === 'dynamic') {
    const localHost = config.localHost.trim();
    if (localHost === '' || !isPort(config.localPort)) {
      return null;
    }

    return {
      ...config,
      id,
      name,
      localHost,
    };
  }

  const targetHost = config.targetHost.trim();
  if (targetHost === '' || !isPort(config.targetPort)) {
    return null;
  }

  if (config.kind === 'local') {
    const localHost = config.localHost.trim();
    if (localHost === '' || !isPort(config.localPort)) {
      return null;
    }

    return {
      ...config,
      id,
      name,
      localHost,
      targetHost,
    };
  }

  const remoteHost = config.remoteHost.trim();
  if (remoteHost === '' || !isPort(config.remotePort)) {
    return null;
  }

  return {
    ...config,
    id,
    name,
    remoteHost,
    targetHost,
  };
}

function normalizeTunnels(tunnels: SavedTunnelConfig[] | undefined): SavedTunnelConfig[] {
  if (!tunnels) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: SavedTunnelConfig[] = [];
  for (const tunnel of tunnels) {
    const nextTunnel = normalizeTunnelConfig(tunnel);
    if (!nextTunnel || seen.has(nextTunnel.id)) {
      continue;
    }

    seen.add(nextTunnel.id);
    normalized.push(nextTunnel);
  }

  return normalized;
}

function isStoredSavedConnection(value: unknown): value is StoredSavedConnection {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    (value.displayName === undefined || typeof value.displayName === 'string') &&
    typeof value.host === 'string' &&
    typeof value.port === 'number' &&
    Number.isFinite(value.port) &&
    typeof value.username === 'string' &&
    (value.authMethod === undefined ||
      value.authMethod === 'password' ||
      value.authMethod === 'privateKey' ||
      value.authMethod === 'agent' ||
      value.authMethod === 'tailscale') &&
    typeof value.password === 'string' &&
    isOptionalSecretEncoding(value.passwordEncoding) &&
    (value.privateKeyPath === undefined || typeof value.privateKeyPath === 'string') &&
    (value.passphrase === undefined || typeof value.passphrase === 'string') &&
    (value.passphraseEncoding === undefined || isOptionalSecretEncoding(value.passphraseEncoding)) &&
    (value.agentSocket === undefined || typeof value.agentSocket === 'string') &&
    (value.hostVerification === undefined || value.hostVerification === 'knownHosts' || value.hostVerification === 'off') &&
    (value.knownHostsPath === undefined || typeof value.knownHostsPath === 'string') &&
    (value.jumpHost === undefined || isStoredJumpHost(value.jumpHost)) &&
    typeof value.lastConnectedAt === 'string' &&
    (value.lastWorkspacePath === undefined || typeof value.lastWorkspacePath === 'string') &&
    (value.workspacePaths === undefined ||
      (Array.isArray(value.workspacePaths) && value.workspacePaths.every((item) => typeof item === 'string'))) &&
    (value.tunnels === undefined || (Array.isArray(value.tunnels) && value.tunnels.every(isSavedTunnelConfig)))
  );
}

function normalizeWorkspacePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawPath of paths) {
    const workspacePath = rawPath.trim();
    if (workspacePath === '' || seen.has(workspacePath)) {
      continue;
    }

    seen.add(workspacePath);
    normalized.push(workspacePath);

    if (normalized.length >= MAX_WORKSPACE_PATHS) {
      break;
    }
  }

  return normalized;
}

function getWorkspacePaths(connection: Pick<StoredSavedConnection, 'workspacePaths' | 'lastWorkspacePath'>): string[] {
  return normalizeWorkspacePaths([
    ...(connection.workspacePaths ?? []),
    ...(connection.lastWorkspacePath ? [connection.lastWorkspacePath] : []),
  ]);
}

function getDefaultDisplayName(connection: Pick<StoredSavedConnection, 'host' | 'username'>): string {
  return `${connection.username}@${connection.host}`;
}

function normalizeDisplayName(
  displayName: string | undefined,
  fallback: Pick<StoredSavedConnection, 'host' | 'username'>,
): string {
  const nextDisplayName = displayName?.trim();
  return nextDisplayName && nextDisplayName.length > 0 ? nextDisplayName : getDefaultDisplayName(fallback);
}

function sameStringArray(left: string[] | undefined, right: string[]): boolean {
  const normalizedLeft = left ?? [];
  return normalizedLeft.length === right.length && normalizedLeft.every((value, index) => value === right[index]);
}

function buildSavedConnectionId(input: Pick<ConnectInput, 'host' | 'port' | 'username'>): string {
  return createHash('sha256')
    .update(JSON.stringify([input.host.trim(), input.port, input.username.trim()]))
    .digest('hex')
    .slice(0, 24);
}

function compareByRecentUse(left: StoredSavedConnection, right: StoredSavedConnection): number {
  return right.lastConnectedAt.localeCompare(left.lastConnectedAt);
}

function summarizeConnection(connection: StoredSavedConnection): SavedConnectionSummary {
  return {
    id: connection.id,
    displayName: normalizeDisplayName(connection.displayName, connection),
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod ?? 'password',
    lastConnectedAt: connection.lastConnectedAt,
    lastWorkspacePath: getWorkspacePaths(connection)[0],
    workspacePaths: getWorkspacePaths(connection),
    tunnels: normalizeTunnels(connection.tunnels),
  };
}

export class SavedConnectionStore {
  private readonly filePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, SAVED_CONNECTIONS_FILE);
  }

  async listSummaries(): Promise<SavedConnectionSummary[]> {
    await this.mutationQueue;
    const data = await this.readData();
    return data.connections.sort(compareByRecentUse).map(summarizeConnection);
  }

  async getConnectInput(savedConnectionId: string): Promise<ConnectInput> {
    await this.mutationQueue;
    const data = await this.readData();
    const connection = data.connections.find((entry) => entry.id === savedConnectionId);

    if (!connection) {
      throw new Error('Saved connection not found');
    }

    return {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      authMethod: connection.authMethod ?? 'password',
      password: this.unprotectOptionalSecret(connection.password, connection.passwordEncoding),
      privateKeyPath: connection.privateKeyPath ?? '',
      passphrase: this.unprotectOptionalSecret(connection.passphrase ?? '', connection.passphraseEncoding ?? 'none'),
      agentSocket: connection.agentSocket ?? '',
      hostVerification: connection.hostVerification ?? 'off',
      knownHostsPath: connection.knownHostsPath ?? '',
      jumpHost: connection.jumpHost
        ? {
            host: connection.jumpHost.host,
            port: connection.jumpHost.port,
            username: connection.jumpHost.username,
            authMethod: connection.jumpHost.authMethod,
            password: this.unprotectOptionalSecret(connection.jumpHost.password, connection.jumpHost.passwordEncoding),
            privateKeyPath: connection.jumpHost.privateKeyPath ?? '',
            passphrase: this.unprotectOptionalSecret(connection.jumpHost.passphrase ?? '', connection.jumpHost.passphraseEncoding ?? 'none'),
            agentSocket: connection.jumpHost.agentSocket ?? '',
          }
        : undefined,
    };
  }

  async getTunnels(savedConnectionId: string): Promise<SavedTunnelConfig[]> {
    await this.mutationQueue;
    const data = await this.readData();
    const connection = data.connections.find((entry) => entry.id === savedConnectionId);
    if (!connection) {
      throw new Error('Saved connection not found');
    }

    return normalizeTunnels(connection.tunnels);
  }

  async getTunnel(savedConnectionId: string, tunnelId: string): Promise<SavedTunnelConfig> {
    const tunnels = await this.getTunnels(savedConnectionId);
    const tunnel = tunnels.find((entry) => entry.id === tunnelId);
    if (!tunnel) {
      throw new Error('Tunnel not found');
    }

    return tunnel;
  }

  getConnectionId(input: Pick<ConnectInput, 'host' | 'port' | 'username'>): string {
    return buildSavedConnectionId(input);
  }

  async saveConnection(input: ConnectInput): Promise<SavedConnectionSummary> {
    return this.runMutation(async (data) => {
      const now = new Date().toISOString();
      const nextConnection = this.createStoredConnection(
        input,
        now,
        data.connections.find((entry) => entry.id === this.getConnectionId(input)),
      );
      const nextData: SavedConnectionsFile = {
        version: 1,
        connections: [nextConnection, ...data.connections.filter((entry) => entry.id !== nextConnection.id)]
          .sort(compareByRecentUse)
          .slice(0, MAX_SAVED_CONNECTIONS),
      };

      await this.writeData(nextData);
      return summarizeConnection(nextConnection);
    });
  }

  async importConnections(inputs: ImportedSshConnection[]): Promise<number> {
    return this.runMutation(async (data) => {
      const now = new Date().toISOString();
      const existing = new Map(data.connections.map((connection) => [connection.id, connection]));
      let imported = 0;
      for (const input of inputs) {
        const id = this.getConnectionId(input);
        const previous = existing.get(id);
        const connection = this.createStoredConnection(input, now, previous);
        existing.set(id, { ...connection, id, displayName: input.displayName.trim() || previous?.displayName || connection.displayName });
        imported += 1;
      }
      if (imported === 0) return 0;
      await this.writeData({ version: 1, connections: [...existing.values()].sort(compareByRecentUse) });
      return imported;
    });
  }

  async updateWorkspacePath(savedConnectionId: string, workspacePath: string): Promise<void> {
    await this.runMutation(async (data) => {
      const normalizedWorkspacePath = workspacePath.trim();
      if (normalizedWorkspacePath === '') {
        return;
      }

      const nextConnections = data.connections.map((entry) => {
        if (entry.id !== savedConnectionId) {
          return entry;
        }

        const nextWorkspacePaths = normalizeWorkspacePaths([
          normalizedWorkspacePath,
          ...getWorkspacePaths(entry),
        ]);

        if (entry.lastWorkspacePath === nextWorkspacePaths[0] && sameStringArray(entry.workspacePaths, nextWorkspacePaths)) {
          return entry;
        }

        return {
          ...entry,
          lastWorkspacePath: nextWorkspacePaths[0],
          workspacePaths: nextWorkspacePaths,
        };
      });

      if (nextConnections.every((entry, index) => entry === data.connections[index])) {
        return;
      }

      await this.writeData({
        version: 1,
        connections: nextConnections,
      });
    });
  }

  async renameConnection(savedConnectionId: string, displayName: string): Promise<void> {
    await this.runMutation(async (data) => {
      const normalizedDisplayName = displayName.trim();
      if (normalizedDisplayName === '') {
        return;
      }

      const nextConnections = data.connections.map((entry) => {
        if (entry.id !== savedConnectionId) {
          return entry;
        }

        if (normalizeDisplayName(entry.displayName, entry) === normalizedDisplayName) {
          return entry;
        }

        return {
          ...entry,
          displayName: normalizedDisplayName,
        };
      });

      if (nextConnections.every((entry, index) => entry === data.connections[index])) {
        return;
      }

      await this.writeData({
        version: 1,
        connections: nextConnections,
      });
    });
  }

  async saveTunnel(savedConnectionId: string, tunnel: SavedTunnelConfig): Promise<void> {
    const normalizedTunnel = normalizeTunnelConfig(tunnel);
    if (!normalizedTunnel) {
      throw new Error('Invalid tunnel configuration');
    }

    await this.runMutation(async (data) => {
      let changed = false;
      const nextConnections = data.connections.map((entry) => {
        if (entry.id !== savedConnectionId) {
          return entry;
        }

        const currentTunnels = normalizeTunnels(entry.tunnels);
        const existingIndex = currentTunnels.findIndex((item) => item.id === normalizedTunnel.id);
        const nextTunnels =
          existingIndex === -1
            ? [normalizedTunnel, ...currentTunnels]
            : currentTunnels.map((item, index) => (index === existingIndex ? normalizedTunnel : item));

        changed = true;
        return {
          ...entry,
          tunnels: nextTunnels,
        };
      });

      if (!changed) {
        throw new Error('Saved connection not found');
      }

      await this.writeData({
        version: 1,
        connections: nextConnections,
      });
    });
  }

  async removeTunnel(savedConnectionId: string, tunnelId: string): Promise<void> {
    await this.runMutation(async (data) => {
      let changed = false;
      const nextConnections = data.connections.map((entry) => {
        if (entry.id !== savedConnectionId) {
          return entry;
        }

        const nextTunnels = normalizeTunnels(entry.tunnels).filter((item) => item.id !== tunnelId);
        changed = true;
        return {
          ...entry,
          tunnels: nextTunnels,
        };
      });

      if (!changed) {
        throw new Error('Saved connection not found');
      }

      await this.writeData({
        version: 1,
        connections: nextConnections,
      });
    });
  }

  async removeConnection(savedConnectionId: string): Promise<void> {
    await this.runMutation(async (data) => {
      const nextConnections = data.connections.filter((entry) => entry.id !== savedConnectionId);
      if (nextConnections.length === data.connections.length) {
        return;
      }

      await this.writeData({
        version: 1,
        connections: nextConnections,
      });
    });
  }

  private async runMutation<T>(operation: (data: SavedConnectionsFile) => Promise<T>): Promise<T> {
    const task = this.mutationQueue.then(async () => operation(await this.readData()));
    this.mutationQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private createStoredConnection(
    input: ConnectInput,
    lastConnectedAt: string,
    previousConnection?: Pick<StoredSavedConnection, 'displayName' | 'lastWorkspacePath' | 'workspacePaths' | 'tunnels'>,
  ): StoredSavedConnection {
    const host = input.host.trim();
    const username = input.username.trim();
    const authMethod = input.authMethod ?? 'password';
    const protectedPassword = this.protectOptionalSecret(authMethod === 'password' ? input.password : '');
    const protectedPassphrase = this.protectOptionalSecret(authMethod === 'privateKey' ? input.passphrase ?? '' : '');

    const workspacePaths = getWorkspacePaths(previousConnection ?? { workspacePaths: [] });

    return {
      id: buildSavedConnectionId({ host, port: input.port, username }),
      displayName: normalizeDisplayName(previousConnection?.displayName, { host, username }),
      host,
      port: input.port,
      username,
      authMethod,
      password: protectedPassword.value,
      passwordEncoding: protectedPassword.encoding,
      privateKeyPath: authMethod === 'privateKey' ? input.privateKeyPath?.trim() ?? '' : '',
      passphrase: protectedPassphrase.value,
      passphraseEncoding: protectedPassphrase.encoding,
      agentSocket: authMethod === 'agent' ? input.agentSocket?.trim() ?? '' : '',
      hostVerification: input.hostVerification ?? 'off',
      knownHostsPath: input.knownHostsPath?.trim() ?? '',
      jumpHost: this.createStoredJumpHost(input.jumpHost),
      lastConnectedAt,
      lastWorkspacePath: workspacePaths[0],
      workspacePaths,
      tunnels: normalizeTunnels(previousConnection?.tunnels),
    };
  }

  private createStoredJumpHost(input: JumpHostInput | undefined): StoredJumpHost | undefined {
    if (!input) {
      return undefined;
    }

    const host = input.host.trim();
    const username = input.username.trim();
    if (host === '' || username === '' || !isPort(input.port)) {
      return undefined;
    }

    const password = this.protectOptionalSecret(input.authMethod === 'password' ? input.password : '');
    const passphrase = this.protectOptionalSecret(input.authMethod === 'privateKey' ? input.passphrase ?? '' : '');
    return {
      host,
      port: input.port,
      username,
      authMethod: input.authMethod,
      password: password.value,
      passwordEncoding: password.encoding,
      privateKeyPath: input.authMethod === 'privateKey' ? input.privateKeyPath?.trim() ?? '' : '',
      passphrase: passphrase.value,
      passphraseEncoding: passphrase.encoding,
      agentSocket: input.authMethod === 'agent' ? input.agentSocket?.trim() ?? '' : '',
    };
  }

  private protectPassword(password: string): { encoding: PasswordEncoding; value: string } {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        encoding: 'safeStorage',
        value: safeStorage.encryptString(password).toString('base64'),
      };
    }

    return {
      encoding: 'plain',
      value: Buffer.from(password, 'utf8').toString('base64'),
    };
  }

  private protectOptionalSecret(secret: string): { encoding: OptionalSecretEncoding; value: string } {
    if (secret === '') {
      return {
        encoding: 'none',
        value: '',
      };
    }

    return this.protectPassword(secret);
  }

  private unprotectPassword(connection: StoredSavedConnection): string {
    const buffer = Buffer.from(connection.password, 'base64');

    if (connection.passwordEncoding === 'safeStorage') {
      return safeStorage.decryptString(buffer);
    }

    return buffer.toString('utf8');
  }

  private unprotectOptionalSecret(value: string, encoding: OptionalSecretEncoding): string {
    if (encoding === 'none' || value === '') {
      return '';
    }

    const buffer = Buffer.from(value, 'base64');
    if (encoding === 'safeStorage') {
      return safeStorage.decryptString(buffer);
    }

    return buffer.toString('utf8');
  }

  private async readData(): Promise<SavedConnectionsFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return this.normalizeData(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        return {
          version: 1,
          connections: [],
        };
      }

      return {
        version: 1,
        connections: [],
      };
    }
  }

  private normalizeData(value: unknown): SavedConnectionsFile {
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.connections)) {
      return {
        version: 1,
        connections: [],
      };
    }

    return {
      version: 1,
      connections: value.connections
        .filter(isStoredSavedConnection)
        .map((connection) => ({
          ...connection,
          authMethod: connection.authMethod ?? 'password',
          hostVerification: connection.hostVerification ?? 'off',
          displayName: normalizeDisplayName(connection.displayName, connection),
          workspacePaths: getWorkspacePaths(connection),
          lastWorkspacePath: getWorkspacePaths(connection)[0],
          tunnels: normalizeTunnels(connection.tunnels),
        }))
        .sort(compareByRecentUse)
        .slice(0, MAX_SAVED_CONNECTIONS),
    };
  }

  private async writeData(data: SavedConnectionsFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}
