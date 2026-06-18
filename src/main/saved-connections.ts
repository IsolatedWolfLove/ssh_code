import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { safeStorage } from 'electron';

import type { ConnectInput, SavedConnectionSummary } from '../shared/contracts';

const SAVED_CONNECTIONS_FILE = 'saved-connections.json';
const MAX_SAVED_CONNECTIONS = 12;
const MAX_WORKSPACE_PATHS = 6;

type PasswordEncoding = 'safeStorage' | 'plain';
type OptionalSecretEncoding = PasswordEncoding | 'none';

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
  lastConnectedAt: string;
  lastWorkspacePath?: string;
  workspacePaths?: string[];
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
      value.authMethod === 'agent') &&
    typeof value.password === 'string' &&
    isOptionalSecretEncoding(value.passwordEncoding) &&
    (value.privateKeyPath === undefined || typeof value.privateKeyPath === 'string') &&
    (value.passphrase === undefined || typeof value.passphrase === 'string') &&
    (value.passphraseEncoding === undefined || isOptionalSecretEncoding(value.passphraseEncoding)) &&
    (value.agentSocket === undefined || typeof value.agentSocket === 'string') &&
    (value.hostVerification === undefined || value.hostVerification === 'knownHosts' || value.hostVerification === 'off') &&
    (value.knownHostsPath === undefined || typeof value.knownHostsPath === 'string') &&
    typeof value.lastConnectedAt === 'string' &&
    (value.lastWorkspacePath === undefined || typeof value.lastWorkspacePath === 'string') &&
    (value.workspacePaths === undefined ||
      (Array.isArray(value.workspacePaths) && value.workspacePaths.every((item) => typeof item === 'string')))
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
    };
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
    previousConnection?: Pick<StoredSavedConnection, 'displayName' | 'lastWorkspacePath' | 'workspacePaths'>,
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
      lastConnectedAt,
      lastWorkspacePath: workspacePaths[0],
      workspacePaths,
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
