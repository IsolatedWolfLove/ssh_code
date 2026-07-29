import { describe, expect, it } from 'vitest';

import { buildMetricsCommand, parseMetricsOutput } from './host-metrics';

const SAMPLE_OUTPUT = [
  '###SSHSTUDIO:GPU',
  '0, NVIDIA GeForce RTX 4090, 97, 21311, 24564, 71, 412.55, 450.00',
  '1, NVIDIA GeForce RTX 4090, 0, 3, 24564, 34, [N/A], [N/A]',
  '###SSHSTUDIO:GPUPROC',
  'GPU-1111, 40321, 20984, python',
  'GPU-1111, 40988, 128, /usr/bin/Xvfb',
  'GPU-2222, 51002, 2, python',
  '###SSHSTUDIO:CPU',
  '12.40 9.80 6.31 14/2841 91234',
  '32',
  '###SSHSTUDIO:MEM',
  'MemTotal: 131980000',
  'MemAvailable: 42990000',
  '###SSHSTUDIO:DISK',
  '/dev/nvme0n1p2 1922728840 1633203292 191725160 90% /',
].join('\n');

describe('metrics command', () => {
  it('reports free space for the open workspace and quotes the path', () => {
    const command = buildMetricsCommand("/home/dev/it's runs");

    expect(command).toContain(`df -Pk '/home/dev/it'\\''s runs'`);
  });

  it('falls back to the root filesystem when no workspace is open', () => {
    expect(buildMetricsCommand('')).toContain("df -Pk '/'");
  });

  it('guards the GPU probes so CPU-only hosts still report', () => {
    expect(buildMetricsCommand('/')).toContain('command -v nvidia-smi');
  });
});

describe('metrics parsing', () => {
  it('reads per-GPU utilisation, memory, temperature and power', () => {
    const snapshot = parseMetricsOutput(SAMPLE_OUTPUT, 1767225600000);

    expect(snapshot.collectedAt).toBe(1767225600000);
    expect(snapshot.gpuAvailable).toBe(true);
    expect(snapshot.gpus).toHaveLength(2);
    expect(snapshot.gpus[0]).toMatchObject({
      index: 0,
      name: 'NVIDIA GeForce RTX 4090',
      utilization: 97,
      memoryUsedMb: 21311,
      memoryTotalMb: 24564,
      temperature: 71,
      powerDrawWatts: 412.55,
      powerLimitWatts: 450,
    });
  });

  it('treats unsupported driver fields as missing rather than zero', () => {
    const snapshot = parseMetricsOutput(SAMPLE_OUTPUT);

    expect(snapshot.gpus[1].powerDrawWatts).toBeUndefined();
    expect(snapshot.gpus[1].powerLimitWatts).toBeUndefined();
    expect(snapshot.gpus[1].utilization).toBe(0);
  });

  it('attributes compute processes to the right GPU', () => {
    const snapshot = parseMetricsOutput(SAMPLE_OUTPUT);

    expect(snapshot.gpus[0].processes).toEqual([
      { pid: 40321, memoryUsedMb: 20984, name: 'python' },
      { pid: 40988, memoryUsedMb: 128, name: '/usr/bin/Xvfb' },
    ]);
    expect(snapshot.gpus[1].processes).toEqual([{ pid: 51002, memoryUsedMb: 2, name: 'python' }]);
  });

  it('reads load, cpu count, memory and disk in mebibytes', () => {
    const snapshot = parseMetricsOutput(SAMPLE_OUTPUT);

    expect(snapshot.loadAverage).toEqual([12.4, 9.8, 6.31]);
    expect(snapshot.cpuCount).toBe(32);
    expect(snapshot.memory).toEqual({ totalMb: 128887, availableMb: 41982 });
    expect(snapshot.disk).toEqual({ mountPath: '/', totalMb: 1877665, availableMb: 187232 });
  });

  it('reports gpuAvailable false on hosts without nvidia-smi', () => {
    const stdout = [
      '###SSHSTUDIO:GPU',
      '###SSHSTUDIO:GPUPROC',
      '###SSHSTUDIO:CPU',
      '0.10 0.20 0.30 1/200 400',
      '8',
      '###SSHSTUDIO:MEM',
      'MemTotal: 16000000',
      'MemAvailable: 8000000',
      '###SSHSTUDIO:DISK',
      '/dev/sda1 100000000 50000000 50000000 50% /data',
    ].join('\n');

    const snapshot = parseMetricsOutput(stdout);

    expect(snapshot.gpuAvailable).toBe(false);
    expect(snapshot.gpus).toEqual([]);
    expect(snapshot.cpuCount).toBe(8);
    expect(snapshot.disk?.mountPath).toBe('/data');
  });

  it('survives a host where every probe is missing', () => {
    const snapshot = parseMetricsOutput('');

    expect(snapshot.gpus).toEqual([]);
    expect(snapshot.loadAverage).toBeUndefined();
    expect(snapshot.memory).toBeUndefined();
    expect(snapshot.disk).toBeUndefined();
  });
});
