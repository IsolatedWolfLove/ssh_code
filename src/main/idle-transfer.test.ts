import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { IdleTransferManager, type IdleRemoteEntry, type IdleTransferSource } from './idle-transfer';

const immediateGovernor = {
  beginForeground: () => () => undefined,
  noteForegroundActivity: () => undefined,
  waitForAllowance: async () => undefined,
};

function createSource(files: Record<string, Buffer>, directories: Record<string, IdleRemoteEntry[]>): IdleTransferSource {
  return {
    stat: async (remotePath) => {
      const data = files[remotePath];
      if (data) {
        return { kind: 'file', size: data.length, modifiedAt: 1234 };
      }
      if (directories[remotePath]) {
        return { kind: 'directory', size: 0 };
      }
      throw new Error(`Missing fixture ${remotePath}`);
    },
    readDir: async (remotePath) => directories[remotePath] ?? [],
    createReadStream: (remotePath) => Readable.from(files[remotePath] ?? Buffer.alloc(0)),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for idle transfer');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('IdleTransferManager', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
  });

  it('automatically caches only media without exceeding its byte limit', async () => {
    const source = createSource(
      {
        '/work/plot.png': Buffer.from('plot'),
        '/work/movie.mp4': Buffer.from('123456'),
        '/work/readme.txt': Buffer.from('ignored'),
      },
      {
        '/work': [
          { name: 'plot.png', path: '/work/plot.png', kind: 'file', size: 4, modifiedAt: 1234 },
          { name: 'movie.mp4', path: '/work/movie.mp4', kind: 'file', size: 6, modifiedAt: 1234 },
          { name: 'readme.txt', path: '/work/readme.txt', kind: 'file', size: 7, modifiedAt: 1234 },
        ],
      },
    );
    const manager = new IdleTransferManager(source, 8, immediateGovernor);
    await manager.startSession();

    manager.startAutomaticMediaCache('/work');
    await waitFor(() => manager.snapshot().cachedBytes === 4);

    expect(await manager.readCached('/work/plot.png', 4, 1234)).toEqual(Buffer.from('plot'));
    expect(await manager.readCached('/work/movie.mp4', 6, 1234)).toBeNull();
    expect(manager.snapshot().cachedBytes).toBeLessThanOrEqual(8);
    await manager.stopSession();
    expect(await manager.readCached('/work/plot.png', 4, 1234)).toBeNull();
  });

  it('recursively downloads a selected directory to a persistent destination', async () => {
    const source = createSource(
      {
        '/data/a.bin': Buffer.from('a'),
        '/data/nested/b.bin': Buffer.from('bb'),
      },
      {
        '/data': [
          { name: 'a.bin', path: '/data/a.bin', kind: 'file', size: 1 },
          { name: 'nested', path: '/data/nested', kind: 'directory' },
        ],
        '/data/nested': [{ name: 'b.bin', path: '/data/nested/b.bin', kind: 'file', size: 2 }],
      },
    );
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-studio-idle-test-'));
    cleanupPaths.push(destinationRoot);
    const destination = path.join(destinationRoot, 'data');
    const manager = new IdleTransferManager(source, 8, immediateGovernor);
    await manager.startSession();

    await manager.queueManualDownload('/data', destination);
    await waitFor(() => manager.snapshot().queuedItems === 0 && !manager.snapshot().activePath);

    expect(await fs.readFile(path.join(destination, 'a.bin'), 'utf8')).toBe('a');
    expect(await fs.readFile(path.join(destination, 'nested', 'b.bin'), 'utf8')).toBe('bb');
    await manager.stopSession();
    expect(await fs.readFile(path.join(destination, 'a.bin'), 'utf8')).toBe('a');
  });

  it('cancels an active idle download without stopping the idle worker', async () => {
    const source: IdleTransferSource = {
      stat: async () => ({ kind: 'file', size: 1 }),
      readDir: async () => [],
      createReadStream: () => new Readable({ read() {} }),
    };
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-studio-idle-cancel-'));
    cleanupPaths.push(destinationRoot);
    const manager = new IdleTransferManager(source, 8, immediateGovernor);
    await manager.startSession();

    await manager.queueManualDownload('/slow.bin', path.join(destinationRoot, 'slow.bin'));
    await waitFor(() => manager.snapshot().activePath === '/slow.bin');

    expect(manager.cancelGroup('/slow.bin').activePath).toBe('/slow.bin');
    await waitFor(() => !manager.snapshot().activePath && manager.snapshot().queuedItems === 0);
    await manager.stopSession();
  });
});
