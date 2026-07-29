import { describe, expect, it } from 'vitest';

import {
  PART_SUFFIX,
  RateEstimator,
  finalFromPart,
  isPartPath,
  resolveResumeOffset,
  toPartPath,
} from './transfer';

describe('part path helpers', () => {
  it('appends and strips the part suffix', () => {
    const remote = '/data/train.tar';
    const part = toPartPath(remote);
    expect(part).toBe(`/data/train.tar${PART_SUFFIX}`);
    expect(isPartPath(part)).toBe(true);
    expect(isPartPath(remote)).toBe(false);
    expect(finalFromPart(part)).toBe(remote);
  });

  it('leaves a non-part path unchanged when stripping', () => {
    expect(finalFromPart('/data/train.tar')).toBe('/data/train.tar');
  });
});

describe('resolveResumeOffset', () => {
  it('starts from zero when no part exists', () => {
    expect(resolveResumeOffset(undefined, 1000)).toBe(0);
    expect(resolveResumeOffset(0, 1000)).toBe(0);
  });

  it('resumes from the end of a partial file', () => {
    expect(resolveResumeOffset(400, 1000)).toBe(400);
  });

  it('restarts when the part is stale (>= source size)', () => {
    expect(resolveResumeOffset(1000, 1000)).toBe(0);
    expect(resolveResumeOffset(1200, 1000)).toBe(0);
  });

  it('floors fractional sizes and ignores non-finite input', () => {
    expect(resolveResumeOffset(399.9, 1000)).toBe(399);
    expect(resolveResumeOffset(Number.NaN, 1000)).toBe(0);
  });
});

describe('RateEstimator', () => {
  it('is undefined until at least two samples exist', () => {
    const estimator = new RateEstimator();
    expect(estimator.bytesPerSecond()).toBeUndefined();
    estimator.record(0, 0);
    expect(estimator.bytesPerSecond()).toBeUndefined();
  });

  it('measures throughput across the window', () => {
    const estimator = new RateEstimator();
    estimator.record(0, 0);
    estimator.record(1_000_000, 1000);
    expect(estimator.bytesPerSecond()).toBe(1_000_000);
  });

  it('derives ETA from the current rate', () => {
    const estimator = new RateEstimator();
    estimator.record(0, 0);
    estimator.record(1_000_000, 1000);
    // 1 MB/s, 3 MB remaining of a 4 MB payload -> 3 s.
    expect(estimator.etaSeconds(1_000_000, 4_000_000)).toBe(3);
  });

  it('reports zero ETA once the total is reached', () => {
    const estimator = new RateEstimator();
    estimator.record(0, 0);
    estimator.record(1_000_000, 1000);
    expect(estimator.etaSeconds(4_000_000, 4_000_000)).toBe(0);
  });

  it('drops samples older than the window so a stall lowers the rate', () => {
    const estimator = new RateEstimator(3000, 8);
    estimator.record(0, 0);
    estimator.record(1_000_000, 1000);
    // A long gap with little progress: old fast samples fall out of the window.
    estimator.record(1_010_000, 9000);
    estimator.record(1_020_000, 10_000);
    const rate = estimator.bytesPerSecond();
    expect(rate).toBeDefined();
    expect(rate!).toBeLessThan(1_000_000);
  });

  it('caps retained samples at maxSamples', () => {
    const estimator = new RateEstimator(60_000, 3);
    for (let i = 0; i <= 10; i += 1) {
      estimator.record(i * 100, i * 1000);
    }
    // Only the last few samples remain, so the rate reflects the recent window.
    expect(estimator.bytesPerSecond()).toBe(100);
  });
});
