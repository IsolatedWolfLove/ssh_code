/**
 * Large transfers (multi-GB datasets, checkpoints) need two things the plain
 * whole-file SFTP streams do not give: byte-level progress and the ability to
 * resume after a dropped connection instead of starting from zero.
 *
 * The engine writes into a sibling `.part` file and only renames it into place
 * once the whole payload has arrived, so an interrupted transfer can pick up
 * from the bytes already written. This module holds the pure pieces of that
 * logic (path derivation, resume-offset decision, rate/ETA estimation) so they
 * can be unit tested without a remote host.
 */

// A control-char-free suffix that is unlikely to collide with a real file and
// is easy to filter out of directory listings.
export const PART_SUFFIX = '.sshstudio-part';

export function isPartPath(path: string): boolean {
  return path.endsWith(PART_SUFFIX);
}

export function toPartPath(path: string): string {
  return `${path}${PART_SUFFIX}`;
}

export function finalFromPart(path: string): string {
  return isPartPath(path) ? path.slice(0, -PART_SUFFIX.length) : path;
}

/**
 * Decides where a resumable transfer should continue from.
 *
 * - No existing part (`partSize` undefined) → start at 0.
 * - Part already as large as (or larger than) the source → it is stale or
 *   complete; discarding and restarting is safer than trusting a mismatched
 *   tail, so return 0 and let the caller truncate.
 * - Otherwise resume from the end of the part.
 */
export function resolveResumeOffset(
  partSize: number | undefined,
  sourceSize: number,
): number {
  if (partSize === undefined || !Number.isFinite(partSize) || partSize <= 0) {
    return 0;
  }

  if (partSize >= sourceSize) {
    return 0;
  }

  return Math.floor(partSize);
}

interface RateSample {
  at: number;
  bytes: number;
}

/**
 * Sliding-window transfer-rate estimator. Samples older than `windowMs` (or
 * beyond `maxSamples`) are dropped, so the reported rate tracks recent
 * throughput rather than a lifetime average that lags after a stall.
 */
export class RateEstimator {
  private readonly samples: RateSample[] = [];

  constructor(
    private readonly windowMs = 3000,
    private readonly maxSamples = 8,
  ) {}

  record(totalBytes: number, at: number): void {
    this.samples.push({ at, bytes: totalBytes });
    const cutoff = at - this.windowMs;
    while (this.samples.length > this.maxSamples || (this.samples.length > 1 && this.samples[0].at < cutoff)) {
      this.samples.shift();
    }
  }

  /** Bytes per second across the current window, or undefined until measurable. */
  bytesPerSecond(): number | undefined {
    if (this.samples.length < 2) {
      return undefined;
    }

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsedMs = last.at - first.at;
    const deltaBytes = last.bytes - first.bytes;
    if (elapsedMs <= 0 || deltaBytes <= 0) {
      return undefined;
    }

    return (deltaBytes / elapsedMs) * 1000;
  }

  /** Seconds until `totalBytes` is reached at the current rate, if known. */
  etaSeconds(transferredBytes: number, totalBytes: number): number | undefined {
    const rate = this.bytesPerSecond();
    if (rate === undefined || rate <= 0) {
      return undefined;
    }

    const remaining = totalBytes - transferredBytes;
    if (remaining <= 0) {
      return 0;
    }

    return remaining / rate;
  }
}
