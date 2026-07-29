import { Activity, ChevronDown, ChevronUp, CircleAlert, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { HostGpuSnapshot, HostMetricsSnapshot } from '../../../shared/contracts';

interface HostMetricsBarProps {
  snapshot: HostMetricsSnapshot | null;
  error: string | null;
  /** Percentage of the workspace filesystem below which free space is flagged. */
  lowDiskPercent?: number;
}

const DEFAULT_LOW_DISK_PERCENT = 10;

function formatGb(megabytes: number): string {
  const gigabytes = megabytes / 1024;
  return gigabytes >= 100 ? `${Math.round(gigabytes)}G` : `${gigabytes.toFixed(1)}G`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)}%`;
}

function getMemoryPercent(gpu: HostGpuSnapshot): number | undefined {
  if (gpu.memoryUsedMb === undefined || !gpu.memoryTotalMb) {
    return undefined;
  }

  return (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100;
}

/**
 * Colour band for a usage bar. Kept coarse on purpose: the point is to notice a
 * card that is pinned or a disk about to fill, not to read an exact value off
 * the colour.
 */
function getLoadLevel(percent: number | undefined): 'idle' | 'busy' | 'full' {
  if (percent === undefined) {
    return 'idle';
  }

  if (percent >= 90) {
    return 'full';
  }

  return percent >= 40 ? 'busy' : 'idle';
}

function UsageBar({ percent, level }: { percent: number | undefined; level: 'idle' | 'busy' | 'full' }) {
  const width = percent === undefined ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <span className="metrics-bar-track">
      <span className={`metrics-bar-fill metrics-bar-fill-${level}`} style={{ width: `${width}%` }} />
    </span>
  );
}

function GpuRow({ gpu }: { gpu: HostGpuSnapshot }) {
  const memoryPercent = getMemoryPercent(gpu);

  return (
    <div className="metrics-gpu-row">
      <div className="metrics-gpu-heading">
        <span className="metrics-gpu-index">GPU {gpu.index}</span>
        <span className="metrics-gpu-name" title={gpu.name}>
          {gpu.name}
        </span>
        {gpu.temperature !== undefined ? <span className="metrics-gpu-temp">{Math.round(gpu.temperature)}°C</span> : null}
        {gpu.powerDrawWatts !== undefined ? (
          <span className="metrics-gpu-power">
            {Math.round(gpu.powerDrawWatts)}
            {gpu.powerLimitWatts !== undefined ? `/${Math.round(gpu.powerLimitWatts)}` : ''} W
          </span>
        ) : null}
      </div>

      <div className="metrics-gpu-meters">
        <div className="metrics-meter">
          <span className="metrics-meter-label">util</span>
          <UsageBar percent={gpu.utilization} level={getLoadLevel(gpu.utilization)} />
          <span className="metrics-meter-value">{formatPercent(gpu.utilization)}</span>
        </div>
        <div className="metrics-meter">
          <span className="metrics-meter-label">mem</span>
          <UsageBar percent={memoryPercent} level={getLoadLevel(memoryPercent)} />
          <span className="metrics-meter-value">
            {gpu.memoryUsedMb !== undefined && gpu.memoryTotalMb !== undefined
              ? `${formatGb(gpu.memoryUsedMb)} / ${formatGb(gpu.memoryTotalMb)}`
              : '—'}
          </span>
        </div>
      </div>

      {gpu.processes.length > 0 ? (
        <ul className="metrics-gpu-processes">
          {gpu.processes.map((process) => (
            <li key={`${gpu.index}-${process.pid}`}>
              <span className="metrics-process-pid">{process.pid}</span>
              <span className="metrics-process-name" title={process.name}>
                {process.name ?? 'unknown'}
              </span>
              {process.memoryUsedMb !== undefined ? (
                <span className="metrics-process-memory">{formatGb(process.memoryUsedMb)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="metrics-gpu-idle">No compute processes</p>
      )}
    </div>
  );
}

/**
 * Always-visible host telemetry strip with an expandable detail panel. The
 * collapsed strip answers "can I start a run here"; the expanded panel answers
 * "whose job is holding card 3".
 */
export function HostMetricsBar({ snapshot, error, lowDiskPercent = DEFAULT_LOW_DISK_PERCENT }: HostMetricsBarProps) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expanded) {
      return;
    }

    function handlePointerDown(event: MouseEvent): void {
      if (!panelRef.current?.contains(event.target as Node)) {
        setExpanded(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [expanded]);

  if (error && !snapshot) {
    return (
      <div className="metrics-strip metrics-strip-error" title={error}>
        <CircleAlert size={13} />
        <span>Host metrics unavailable</span>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="metrics-strip metrics-strip-idle">
        <Activity size={13} />
        <span>Reading host metrics</span>
      </div>
    );
  }

  const busiestGpu = snapshot.gpus.reduce<HostGpuSnapshot | null>((busiest, gpu) => {
    const current = getMemoryPercent(gpu) ?? gpu.utilization ?? 0;
    const best = busiest ? (getMemoryPercent(busiest) ?? busiest.utilization ?? 0) : -1;
    return current > best ? gpu : busiest;
  }, null);
  const totalGpuMemoryUsed = snapshot.gpus.reduce((total, gpu) => total + (gpu.memoryUsedMb ?? 0), 0);
  const totalGpuMemory = snapshot.gpus.reduce((total, gpu) => total + (gpu.memoryTotalMb ?? 0), 0);
  const diskPercentFree = snapshot.disk ? (snapshot.disk.availableMb / snapshot.disk.totalMb) * 100 : undefined;
  const diskLow = diskPercentFree !== undefined && diskPercentFree < lowDiskPercent;
  const memoryPercentUsed = snapshot.memory
    ? ((snapshot.memory.totalMb - snapshot.memory.availableMb) / snapshot.memory.totalMb) * 100
    : undefined;

  return (
    <div className="metrics-strip-wrap" ref={panelRef}>
      <button
        type="button"
        className={`metrics-strip${expanded ? ' metrics-strip-open' : ''}`}
        onClick={() => {
          setExpanded((previous) => !previous);
        }}
        title="Remote host resources"
      >
        {snapshot.gpuAvailable ? (
          <span className="metrics-chip" title="Busiest GPU: utilisation and memory in use">
            <Activity size={13} />
            <span>
              {snapshot.gpus.length} GPU · {formatPercent(busiestGpu?.utilization)} ·{' '}
              {totalGpuMemory > 0 ? `${formatGb(totalGpuMemoryUsed)}/${formatGb(totalGpuMemory)}` : '—'}
            </span>
          </span>
        ) : (
          <span className="metrics-chip metrics-chip-muted" title="No nvidia-smi on this host">
            <Activity size={13} />
            <span>No GPU</span>
          </span>
        )}

        {snapshot.loadAverage ? (
          <span
            className="metrics-chip"
            title={`Load average 1/5/15 min${snapshot.cpuCount ? ` across ${snapshot.cpuCount} CPUs` : ''}`}
          >
            <Cpu size={13} />
            <span>
              {snapshot.loadAverage[0].toFixed(1)}
              {snapshot.cpuCount ? ` / ${snapshot.cpuCount}` : ''}
            </span>
          </span>
        ) : null}

        {snapshot.memory ? (
          <span className="metrics-chip" title="System memory in use">
            <MemoryStick size={13} />
            <span>
              {formatGb(snapshot.memory.totalMb - snapshot.memory.availableMb)}/{formatGb(snapshot.memory.totalMb)}
            </span>
          </span>
        ) : null}

        {snapshot.disk ? (
          <span
            className={`metrics-chip${diskLow ? ' metrics-chip-alert' : ''}`}
            title={`Free space on ${snapshot.disk.mountPath}${diskLow ? ' — checkpoints may fail to write' : ''}`}
          >
            <HardDrive size={13} />
            <span>{formatGb(snapshot.disk.availableMb)} free</span>
          </span>
        ) : null}

        {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>

      {expanded ? (
        <div className="metrics-panel">
          {error ? (
            <p className="metrics-panel-error">
              <CircleAlert size={13} />
              <span>{error}</span>
            </p>
          ) : null}

          {snapshot.gpuAvailable ? (
            snapshot.gpus.map((gpu) => <GpuRow key={gpu.index} gpu={gpu} />)
          ) : (
            <p className="metrics-panel-empty">
              nvidia-smi is not available on this host, so GPU details cannot be read.
            </p>
          )}

          <div className="metrics-panel-footer">
            {snapshot.memory ? (
              <div className="metrics-meter">
                <span className="metrics-meter-label">RAM</span>
                <UsageBar percent={memoryPercentUsed} level={getLoadLevel(memoryPercentUsed)} />
                <span className="metrics-meter-value">
                  {formatGb(snapshot.memory.totalMb - snapshot.memory.availableMb)} /{' '}
                  {formatGb(snapshot.memory.totalMb)}
                </span>
              </div>
            ) : null}

            {snapshot.disk ? (
              <div className="metrics-meter">
                <span className="metrics-meter-label" title={snapshot.disk.mountPath}>
                  Disk
                </span>
                <UsageBar
                  percent={diskPercentFree === undefined ? undefined : 100 - diskPercentFree}
                  level={diskLow ? 'full' : getLoadLevel(diskPercentFree === undefined ? undefined : 100 - diskPercentFree)}
                />
                <span className="metrics-meter-value">
                  {formatGb(snapshot.disk.availableMb)} free of {formatGb(snapshot.disk.totalMb)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
