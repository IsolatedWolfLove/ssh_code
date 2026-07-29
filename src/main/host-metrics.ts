import type {
  HostDiskUsage,
  HostGpuProcess,
  HostGpuSnapshot,
  HostMetricsSnapshot,
} from '../shared/contracts';

import { quoteForShell } from './shell';

/**
 * Remote host telemetry for GPU boxes: per-GPU utilisation/memory/temperature,
 * which processes own each GPU, plus load, RAM and free space on the workspace
 * filesystem. Everything is collected with one `exec` per poll so a short
 * interval stays cheap, and all parsing lives here so it can be unit tested
 * against real `nvidia-smi` / `/proc` output.
 */

// Section markers let a single command return several unrelated outputs while
// keeping the parser resilient to missing tools (a section simply stays empty).
const SECTION_PREFIX = '###SSHSTUDIO:';
const GPU_SECTION = 'GPU';
const GPU_PROCESS_SECTION = 'GPUPROC';
const CPU_SECTION = 'CPU';
const MEMORY_SECTION = 'MEM';
const DISK_SECTION = 'DISK';

const GPU_QUERY_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'power.limit',
].join(',');

const GPU_PROCESS_QUERY_FIELDS = ['gpu_uuid', 'pid', 'used_gpu_memory', 'process_name'].join(',');

function sectionHeader(name: string): string {
  return `${SECTION_PREFIX}${name}`;
}

function emitSection(name: string): string {
  return `echo ${quoteForShell(sectionHeader(name))}`;
}

/**
 * Builds the single shell command used for one metrics poll. Every probe is
 * guarded so hosts without `nvidia-smi` (CPU-only nodes) still return CPU,
 * memory and disk numbers instead of failing the whole snapshot.
 */
export function buildMetricsCommand(workspacePath: string): string {
  const diskTarget = workspacePath.trim() === '' ? '/' : workspacePath;

  return [
    emitSection(GPU_SECTION),
    `if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=${GPU_QUERY_FIELDS} --format=csv,noheader,nounits 2>/dev/null || true; fi`,
    emitSection(GPU_PROCESS_SECTION),
    `if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-compute-apps=${GPU_PROCESS_QUERY_FIELDS} --format=csv,noheader,nounits 2>/dev/null || true; fi`,
    emitSection(CPU_SECTION),
    'cat /proc/loadavg 2>/dev/null || true',
    'nproc 2>/dev/null || true',
    emitSection(MEMORY_SECTION),
    "awk '/^MemTotal:|^MemAvailable:/ {print $1, $2}' /proc/meminfo 2>/dev/null || true",
    emitSection(DISK_SECTION),
    `df -Pk ${quoteForShell(diskTarget)} 2>/dev/null | tail -n 1 || true`,
  ].join('\n');
}

interface ParsedSections {
  [section: string]: string[];
}

function splitSections(stdout: string): ParsedSections {
  const sections: ParsedSections = {};
  let current: string | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith(SECTION_PREFIX)) {
      current = line.slice(SECTION_PREFIX.length).trim();
      sections[current] = [];
      continue;
    }

    if (current === null || line.trim() === '') {
      continue;
    }

    sections[current].push(line);
  }

  return sections;
}

export function parseMetricsOutput(stdout: string, collectedAt = Date.now()): HostMetricsSnapshot {
  const sections = splitSections(stdout);
  const gpus = parseGpuRows(sections[GPU_SECTION] ?? []);
  attachGpuProcesses(gpus, sections[GPU_PROCESS_SECTION] ?? []);
  const cpu = parseCpuRows(sections[CPU_SECTION] ?? []);

  return {
    collectedAt,
    gpus,
    gpuAvailable: (sections[GPU_SECTION] ?? []).length > 0,
    loadAverage: cpu.loadAverage,
    cpuCount: cpu.cpuCount,
    memory: parseMemoryRows(sections[MEMORY_SECTION] ?? []),
    disk: parseDiskRow(sections[DISK_SECTION] ?? []),
  };
}

/**
 * `nvidia-smi --query-gpu` in CSV mode emits `[N/A]` (and occasionally
 * `[Not Supported]`) for fields the driver or card cannot report, e.g. power
 * draw on consumer cards. Those become undefined rather than 0 so the UI can
 * hide them instead of showing a misleading zero.
 */
function parseGpuRows(lines: string[]): HostGpuSnapshot[] {
  const gpus: HostGpuSnapshot[] = [];

  for (const line of lines) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < 5) {
      continue;
    }

    const index = toNumber(cells[0]);
    if (index === undefined) {
      continue;
    }

    gpus.push({
      index,
      name: cells[1] ?? `GPU ${index}`,
      utilization: toNumber(cells[2]),
      memoryUsedMb: toNumber(cells[3]),
      memoryTotalMb: toNumber(cells[4]),
      temperature: toNumber(cells[5]),
      powerDrawWatts: toNumber(cells[6]),
      powerLimitWatts: toNumber(cells[7]),
      processes: [],
    });
  }

  return gpus;
}

/**
 * Compute-app rows identify their GPU by UUID, which the `--query-gpu` output
 * above does not include. Rather than issuing a second UUID lookup every poll,
 * distinct UUIDs are mapped onto GPUs in first-seen order, which matches
 * nvidia-smi's stable index ordering.
 */
function attachGpuProcesses(gpus: HostGpuSnapshot[], lines: string[]): void {
  if (gpus.length === 0) {
    return;
  }

  const uuidOrder: string[] = [];

  for (const line of lines) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }

    const uuid = cells[0];
    const pid = toNumber(cells[1]);
    if (uuid === '' || pid === undefined) {
      continue;
    }

    if (!uuidOrder.includes(uuid)) {
      uuidOrder.push(uuid);
    }

    const gpu = gpus[uuidOrder.indexOf(uuid)];
    if (!gpu) {
      continue;
    }

    const process: HostGpuProcess = {
      pid,
      memoryUsedMb: toNumber(cells[2]),
      name: cells[3] && cells[3] !== '' ? cells[3] : undefined,
    };
    gpu.processes.push(process);
  }
}

function parseCpuRows(lines: string[]): { loadAverage?: [number, number, number]; cpuCount?: number } {
  let loadAverage: [number, number, number] | undefined;
  let cpuCount: number | undefined;

  for (const line of lines) {
    const cells = line.trim().split(/\s+/);
    // /proc/loadavg: "0.52 0.58 0.59 2/1234 56789"
    if (cells.length >= 3 && cells[3]?.includes('/')) {
      const one = toNumber(cells[0]);
      const five = toNumber(cells[1]);
      const fifteen = toNumber(cells[2]);
      if (one !== undefined && five !== undefined && fifteen !== undefined) {
        loadAverage = [one, five, fifteen];
      }
      continue;
    }

    if (cells.length === 1) {
      cpuCount = toNumber(cells[0]);
    }
  }

  return { loadAverage, cpuCount };
}

function parseMemoryRows(lines: string[]): HostMetricsSnapshot['memory'] {
  let totalKb: number | undefined;
  let availableKb: number | undefined;

  for (const line of lines) {
    const [label, value] = line.trim().split(/\s+/);
    const parsed = toNumber(value);
    if (parsed === undefined) {
      continue;
    }

    if (label === 'MemTotal:') {
      totalKb = parsed;
    } else if (label === 'MemAvailable:') {
      availableKb = parsed;
    }
  }

  if (totalKb === undefined || availableKb === undefined) {
    return undefined;
  }

  return {
    totalMb: Math.round(totalKb / 1024),
    availableMb: Math.round(availableKb / 1024),
  };
}

/**
 * `df -Pk` output for one filesystem. POSIX mode keeps it on a single line even
 * for long device names, which the default output wraps.
 */
function parseDiskRow(lines: string[]): HostDiskUsage | undefined {
  const line = lines[lines.length - 1];
  if (!line) {
    return undefined;
  }

  const cells = line.trim().split(/\s+/);
  if (cells.length < 6) {
    return undefined;
  }

  const totalKb = toNumber(cells[1]);
  const availableKb = toNumber(cells[3]);
  if (totalKb === undefined || availableKb === undefined) {
    return undefined;
  }

  return {
    mountPath: cells[5],
    totalMb: Math.round(totalKb / 1024),
    availableMb: Math.round(availableKb / 1024),
  };
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('[')) {
    return undefined;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
