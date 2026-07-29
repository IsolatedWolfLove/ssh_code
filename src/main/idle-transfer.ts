import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_CACHE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
const FOREGROUND_QUIET_PERIOD_MS = 900;
const MAX_AUTOMATIC_SCAN_ENTRIES = 20_000;
const MEDIA_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.png',
  '.svg',
  '.webm',
  '.webp',
]);

export interface IdleRemoteEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  modifiedAt?: number;
}

export interface IdleTransferSource {
  stat(remotePath: string): Promise<{ kind: 'file' | 'directory'; size: number; modifiedAt?: number }>;
  readDir(remotePath: string): Promise<IdleRemoteEntry[]>;
  createReadStream(remotePath: string): Readable;
}

export interface IdleTransferSnapshot {
  queuedItems: number;
  activePath?: string;
  cachedBytes: number;
  cacheLimitBytes: number;
}

interface CacheRecord {
  localPath: string;
  size: number;
  modifiedAt?: number;
}

interface TransferItem {
  remotePath: string;
  localPath: string;
  size: number;
  modifiedAt?: number;
  cache: boolean;
}

function abortError(): Error {
  const error = new Error('Idle transfer stopped');
  error.name = 'AbortError';
  return error;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/**
 * Cooperative bandwidth governor for low-priority transfers.
 *
 * Foreground traffic always wins: background reads stop applying backpressure
 * until the connection has been quiet for a short period. Once quiet, the
 * allowance ramps from 256 KiB/s to 8 MiB/s; any new foreground activity drops
 * it back to zero immediately.
 */
export class IdleBandwidthGovernor {
  private foregroundOperations = 0;
  private lastForegroundActivity = Date.now();

  beginForeground(): () => void {
    this.foregroundOperations += 1;
    this.noteForegroundActivity();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.foregroundOperations = Math.max(0, this.foregroundOperations - 1);
      this.noteForegroundActivity();
    };
  }

  noteForegroundActivity(): void {
    this.lastForegroundActivity = Date.now();
  }

  async waitForAllowance(byteCount: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const quietFor = Date.now() - this.lastForegroundActivity;
      if (this.foregroundOperations === 0 && quietFor >= FOREGROUND_QUIET_PERIOD_MS) {
        const activityMarker = this.lastForegroundActivity;
        const bytesPerSecond =
          quietFor < 3_000
            ? 256 * 1024
            : quietFor < 8_000
              ? 1024 * 1024
              : quietFor < 20_000
                ? 4 * 1024 * 1024
                : 8 * 1024 * 1024;
        await delay(Math.max(1, Math.ceil((byteCount / bytesPerSecond) * 1000)), signal);
        if (this.foregroundOperations === 0 && this.lastForegroundActivity === activityMarker) {
          return;
        }
        continue;
      }

      await delay(Math.max(25, FOREGROUND_QUIET_PERIOD_MS - quietFor), signal);
    }

    throw abortError();
  }
}

export class IdleTransferManager {
  readonly governor: Pick<IdleBandwidthGovernor, 'beginForeground' | 'noteForegroundActivity' | 'waitForAllowance'>;

  private readonly cacheLimitBytes: number;
  private readonly source: IdleTransferSource;
  private cacheDirectory: string | null = null;
  private cacheRecords = new Map<string, CacheRecord>();
  private cachedBytes = 0;
  private reservedCacheBytes = 0;
  private queue: TransferItem[] = [];
  private queuedPaths = new Set<string>();
  private abortController: AbortController | null = null;
  private worker: Promise<void> | null = null;
  private activePath: string | undefined;
  private automaticScanGeneration = 0;

  constructor(
    source: IdleTransferSource,
    cacheLimitBytes = DEFAULT_CACHE_LIMIT_BYTES,
    governor: Pick<IdleBandwidthGovernor, 'beginForeground' | 'noteForegroundActivity' | 'waitForAllowance'> =
      new IdleBandwidthGovernor(),
  ) {
    this.source = source;
    this.cacheLimitBytes = Math.min(DEFAULT_CACHE_LIMIT_BYTES, Math.max(1, cacheLimitBytes));
    this.governor = governor;
  }

  snapshot(): IdleTransferSnapshot {
    return {
      queuedItems: this.queue.length,
      activePath: this.activePath,
      cachedBytes: this.cachedBytes,
      cacheLimitBytes: this.cacheLimitBytes,
    };
  }

  async startSession(): Promise<void> {
    await this.stopSession();
    this.abortController = new AbortController();
    this.cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-studio-preview-'));
  }

  async stopSession(): Promise<void> {
    this.automaticScanGeneration += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.queue = [];
    this.queuedPaths.clear();
    await this.worker?.catch(() => undefined);
    this.worker = null;
    this.activePath = undefined;
    this.cacheRecords.clear();
    this.cachedBytes = 0;
    this.reservedCacheBytes = 0;

    const directory = this.cacheDirectory;
    this.cacheDirectory = null;
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Replaces the automatic media scan with the newly visible workspace.
   * Manual downloads already in the queue are retained.
   */
  startAutomaticMediaCache(remoteDirectory: string): void {
    const generation = ++this.automaticScanGeneration;
    const discarded = this.queue.filter((item) => item.cache);
    this.queue = this.queue.filter((item) => !item.cache);
    this.reservedCacheBytes = Math.max(
      0,
      this.reservedCacheBytes - discarded.reduce((total, item) => total + item.size, 0),
    );
    for (const queuedPath of [...this.queuedPaths]) {
      if (!this.queue.some((item) => item.remotePath === queuedPath)) {
        this.queuedPaths.delete(queuedPath);
      }
    }

    void this.scanAutomaticDirectory(remoteDirectory, generation).catch(() => undefined);
  }

  async queueManualDownload(remotePath: string, localPath: string): Promise<IdleTransferSnapshot> {
    const signal = this.requireSignal();
    await this.waitUntilIdle(signal);
    const stat = await this.source.stat(remotePath);
    if (stat.kind === 'file') {
      this.enqueue({
        remotePath,
        localPath,
        size: stat.size,
        modifiedAt: stat.modifiedAt,
        cache: false,
      });
    } else {
      await this.queueDirectory(remotePath, localPath, signal);
    }
    this.ensureWorker();
    return this.snapshot();
  }

  async readCached(remotePath: string, size: number, modifiedAt?: number): Promise<Buffer | null> {
    const record = this.cacheRecords.get(remotePath);
    if (
      !record ||
      record.size !== size ||
      (modifiedAt !== undefined && record.modifiedAt !== undefined && record.modifiedAt !== modifiedAt)
    ) {
      return null;
    }

    try {
      return await fs.readFile(record.localPath);
    } catch {
      this.cacheRecords.delete(remotePath);
      this.cachedBytes = Math.max(0, this.cachedBytes - record.size);
      return null;
    }
  }

  private requireSignal(): AbortSignal {
    const signal = this.abortController?.signal;
    if (!signal || signal.aborted) {
      throw new Error('No active idle-transfer session');
    }
    return signal;
  }

  private async waitUntilIdle(signal: AbortSignal): Promise<void> {
    await this.governor.waitForAllowance(1, signal);
  }

  private async scanAutomaticDirectory(remoteDirectory: string, generation: number): Promise<void> {
    const signal = this.requireSignal();
    const directories = [remoteDirectory];
    let scannedEntries = 0;
    let reservedBytes = this.cachedBytes + this.reservedCacheBytes;

    while (
      directories.length > 0 &&
      scannedEntries < MAX_AUTOMATIC_SCAN_ENTRIES &&
      generation === this.automaticScanGeneration &&
      !signal.aborted
    ) {
      await this.waitUntilIdle(signal);
      const directory = directories.shift()!;
      const entries = await this.source.readDir(directory);
      scannedEntries += entries.length;

      for (const entry of entries) {
        if (entry.kind === 'directory') {
          directories.push(entry.path);
          continue;
        }
        if (!MEDIA_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) {
          continue;
        }

        const size = Math.max(0, entry.size ?? 0);
        if (size === 0 || reservedBytes + size > this.cacheLimitBytes || this.cacheRecords.has(entry.path)) {
          continue;
        }

        const cacheDirectory = this.cacheDirectory;
        if (!cacheDirectory) {
          return;
        }
        reservedBytes += size;
        this.enqueue({
          remotePath: entry.path,
          localPath: path.join(cacheDirectory, `${this.queuedPaths.size}-${path.basename(entry.name)}`),
          size,
          modifiedAt: entry.modifiedAt,
          cache: true,
        });
      }
    }

    this.ensureWorker();
  }

  private async queueDirectory(remoteDirectory: string, localDirectory: string, signal: AbortSignal): Promise<void> {
    await fs.mkdir(localDirectory, { recursive: true });
    const directories: Array<{ remote: string; local: string }> = [
      { remote: remoteDirectory, local: localDirectory },
    ];

    while (directories.length > 0 && !signal.aborted) {
      await this.waitUntilIdle(signal);
      const current = directories.shift()!;
      const entries = await this.source.readDir(current.remote);
      for (const entry of entries) {
        const localEntryPath = path.join(current.local, entry.name);
        if (entry.kind === 'directory') {
          await fs.mkdir(localEntryPath, { recursive: true });
          directories.push({ remote: entry.path, local: localEntryPath });
        } else {
          this.enqueue({
            remotePath: entry.path,
            localPath: localEntryPath,
            size: Math.max(0, entry.size ?? 0),
            modifiedAt: entry.modifiedAt,
            cache: false,
          });
        }
      }
    }
  }

  private enqueue(item: TransferItem): void {
    if (
      this.queue.some(
        (queued) =>
          queued.remotePath === item.remotePath &&
          (item.cache || queued.localPath === item.localPath),
      ) ||
      (item.cache && this.cacheRecords.has(item.remotePath))
    ) {
      return;
    }
    this.queuedPaths.add(item.remotePath);
    this.queue.push(item);
    if (item.cache) {
      this.reservedCacheBytes += item.size;
    }
  }

  private ensureWorker(): void {
    if (this.worker || this.queue.length === 0) {
      return;
    }
    this.worker = this.runWorker()
      .catch(() => undefined)
      .finally(() => {
        this.worker = null;
        if (this.queue.length > 0 && this.abortController && !this.abortController.signal.aborted) {
          this.ensureWorker();
        }
      });
  }

  private async runWorker(): Promise<void> {
    const signal = this.requireSignal();
    while (this.queue.length > 0 && !signal.aborted) {
      const item = this.queue.shift()!;
      this.activePath = item.remotePath;
      try {
        await this.transferFile(item, signal);
        if (item.cache) {
          this.reservedCacheBytes = Math.max(0, this.reservedCacheBytes - item.size);
          this.cacheRecords.set(item.remotePath, {
            localPath: item.localPath,
            size: item.size,
            modifiedAt: item.modifiedAt,
          });
          this.cachedBytes += item.size;
        }
      } catch (error) {
        if (item.cache) {
          this.reservedCacheBytes = Math.max(0, this.reservedCacheBytes - item.size);
        }
        await fs.rm(`${item.localPath}.part`, { force: true }).catch(() => undefined);
        if ((error as Error).name === 'AbortError') {
          throw error;
        }
      } finally {
        this.queuedPaths.delete(item.remotePath);
        this.activePath = undefined;
      }
    }
  }

  private async transferFile(item: TransferItem, signal: AbortSignal): Promise<void> {
    await fs.mkdir(path.dirname(item.localPath), { recursive: true });
    if (!item.cache) {
      try {
        await fs.access(item.localPath);
        return;
      } catch {
        // Destination is free. Idle downloads never overwrite an existing file.
      }
    }
    const partPath = `${item.localPath}.part`;
    const remote = this.source.createReadStream(item.remotePath);
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.governor
          .waitForAllowance(chunk.length, signal)
          .then(() => callback(null, chunk))
          .catch((error) => callback(error as Error));
      },
    });

    const onAbort = () => {
      remote.destroy(abortError());
      limiter.destroy(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await pipeline(remote, limiter, createWriteStream(partPath));
      if (item.size > 0) {
        const stats = await fs.stat(partPath);
        if (stats.size !== item.size) {
          throw new Error(`Incomplete idle download for ${item.remotePath}`);
        }
      }
      await fs.rename(partPath, item.localPath);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
