import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { SavedConnectionStore } from './saved-connections';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('SSH config import leaves an existing Tailscale connection authentication intact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-studio-connections-'));
  temporaryDirectories.push(directory);
  const store = new SavedConnectionStore(directory);
  const host = 'machine.example.ts.net';
  const username = 'alice';
  const id = store.getConnectionId({ host, port: 22, username });

  await store.saveConnection({ host, port: 22, username, authMethod: 'tailscale', password: '' });
  const imported = await store.importConnections([{
    displayName: 'machine',
    host,
    port: 22,
    username,
    authMethod: 'privateKey',
    password: '',
    privateKeyPath: '/home/alice/.ssh/id_ed25519',
  }]);

  expect(imported).toBe(0);
  expect(await store.getConnectInput(id)).toMatchObject({ authMethod: 'tailscale', privateKeyPath: '' });
});
