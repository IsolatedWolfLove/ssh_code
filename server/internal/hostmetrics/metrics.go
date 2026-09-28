// Package hostmetrics implements the combined GPU/CPU/memory/disk snapshot
// command and parser that replace src/main/host-metrics.ts for the Wails
// backend, plus a polling loop that replaces the HostMetricsPoller logic in
// src/main/ssh-session.ts (startHostMetrics/stopHostMetrics/
// runHostMetricsPoll/scheduleHostMetricsPoll).
//
// This package has no dependency on internal/ssh: BuildMetricsCommand/
// ParseMetricsOutput are pure string functions, and Poller/Collect take an
// injected exec function rather than an *ssh.Session, so the integration
// pass can wire either a real SSH exec channel or a test double without this
// package needing to know about internal/ssh's types.
package hostmetrics

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// Section markers mirror SECTION_PREFIX/GPU_SECTION/etc. in host-metrics.ts
// exactly, since ParseMetricsOutput must parse what BuildMetricsCommand
// produces.
const (
	sectionPrefix     = "###SSHSTUDIO:"
	gpuSection        = "GPU"
	gpuProcessSection = "GPUPROC"
	cpuSection        = "CPU"
	memorySection     = "MEM"
	diskSection       = "DISK"
	gpuQueryFields    = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit"
	gpuProcessFields  = "gpu_uuid,pid,used_gpu_memory,process_name"
)

// DefaultIntervalMs mirrors HOST_METRICS_DEFAULT_INTERVAL_MS in
// ssh-session.ts.
const DefaultIntervalMs = 4000

// MinIntervalMs mirrors HOST_METRICS_MIN_INTERVAL_MS in ssh-session.ts.
const MinIntervalMs = 1000

// GpuProcess mirrors contracts.ts's HostGpuProcess.
type GpuProcess struct {
	PID          int      `json:"pid"`
	MemoryUsedMb *float64 `json:"memoryUsedMb,omitempty"`
	Name         *string  `json:"name,omitempty"`
}

// GpuSnapshot mirrors contracts.ts's HostGpuSnapshot.
type GpuSnapshot struct {
	Index           int          `json:"index"`
	Name            string       `json:"name"`
	Utilization     *float64     `json:"utilization,omitempty"`
	MemoryUsedMb    *float64     `json:"memoryUsedMb,omitempty"`
	MemoryTotalMb   *float64     `json:"memoryTotalMb,omitempty"`
	Temperature     *float64     `json:"temperature,omitempty"`
	PowerDrawWatts  *float64     `json:"powerDrawWatts,omitempty"`
	PowerLimitWatts *float64     `json:"powerLimitWatts,omitempty"`
	Processes       []GpuProcess `json:"processes"`
}

// MemoryUsage mirrors the inline `memory` object in contracts.ts's
// HostMetricsSnapshot.
type MemoryUsage struct {
	TotalMb     int64 `json:"totalMb"`
	AvailableMb int64 `json:"availableMb"`
}

// DiskUsage mirrors contracts.ts's HostDiskUsage.
type DiskUsage struct {
	MountPath   string `json:"mountPath"`
	TotalMb     int64  `json:"totalMb"`
	AvailableMb int64  `json:"availableMb"`
}

// Snapshot mirrors contracts.ts's HostMetricsSnapshot. CollectedAt is
// milliseconds since epoch, matching the TS side's Date.now()-style value.
type Snapshot struct {
	CollectedAt  int64         `json:"collectedAt"`
	Gpus         []GpuSnapshot `json:"gpus"`
	GpuAvailable bool          `json:"gpuAvailable"`
	LoadAverage  *[3]float64   `json:"loadAverage,omitempty"`
	CpuCount     *int          `json:"cpuCount,omitempty"`
	Memory       *MemoryUsage  `json:"memory,omitempty"`
	Disk         *DiskUsage    `json:"disk,omitempty"`
}

// quoteForShell mirrors quoteForShell in shell.ts. Duplicated here (rather
// than importing internal/ssh's identical QuoteForShell) to keep this
// package free of any dependency on internal/ssh, which another fork may be
// editing concurrently this round.
func quoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func sectionHeader(name string) string {
	return sectionPrefix + name
}

func emitSection(name string) string {
	return "echo " + quoteForShell(sectionHeader(name))
}

// BuildMetricsCommand mirrors buildMetricsCommand in host-metrics.ts: one
// shell command that probes GPU (if nvidia-smi exists), CPU, memory, and disk
// free space for workspacePath (or "/" when empty), each behind a section
// marker so the whole snapshot is one round-trip and missing tools degrade
// gracefully instead of failing the request.
func BuildMetricsCommand(workspacePath string) string {
	diskTarget := strings.TrimSpace(workspacePath)
	if diskTarget == "" {
		diskTarget = "/"
	} else {
		diskTarget = workspacePath
	}

	lines := []string{
		emitSection(gpuSection),
		"if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=" + gpuQueryFields + " --format=csv,noheader,nounits 2>/dev/null || true; fi",
		emitSection(gpuProcessSection),
		"if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-compute-apps=" + gpuProcessFields + " --format=csv,noheader,nounits 2>/dev/null || true; fi",
		emitSection(cpuSection),
		"cat /proc/loadavg 2>/dev/null || true",
		"nproc 2>/dev/null || true",
		emitSection(memorySection),
		"awk '/^MemTotal:|^MemAvailable:/ {print $1, $2}' /proc/meminfo 2>/dev/null || true",
		emitSection(diskSection),
		"df -Pk " + quoteForShell(diskTarget) + " 2>/dev/null | tail -n 1 || true",
	}
	return strings.Join(lines, "\n")
}

func splitSections(stdout string) map[string][]string {
	sections := make(map[string][]string)
	var current string
	inSection := false

	for _, rawLine := range strings.Split(stdout, "\n") {
		line := strings.TrimRight(rawLine, " \t\r")
		if strings.HasPrefix(line, sectionPrefix) {
			current = strings.TrimSpace(strings.TrimPrefix(line, sectionPrefix))
			sections[current] = []string{}
			inSection = true
			continue
		}

		if !inSection || strings.TrimSpace(line) == "" {
			continue
		}

		sections[current] = append(sections[current], line)
	}

	return sections
}

// ParseMetricsOutput mirrors parseMetricsOutput in host-metrics.ts.
// collectedAt is milliseconds since epoch; pass time.Now().UnixMilli() for
// "now" behavior (mirroring the TS default parameter Date.now()).
func ParseMetricsOutput(stdout string, collectedAt int64) Snapshot {
	sections := splitSections(stdout)

	gpuLines := sections[gpuSection]
	gpus := parseGpuRows(gpuLines)
	attachGpuProcesses(gpus, sections[gpuProcessSection])
	loadAverage, cpuCount := parseCpuRows(sections[cpuSection])

	return Snapshot{
		CollectedAt:  collectedAt,
		Gpus:         gpus,
		GpuAvailable: len(gpuLines) > 0,
		LoadAverage:  loadAverage,
		CpuCount:     cpuCount,
		Memory:       parseMemoryRows(sections[memorySection]),
		Disk:         parseDiskRow(sections[diskSection]),
	}
}

// parseGpuRows mirrors parseGpuRows in host-metrics.ts: nvidia-smi CSV rows,
// tolerating "[N/A]"/"[Not Supported]" cells by leaving the field nil rather
// than reporting a misleading zero.
func parseGpuRows(lines []string) []GpuSnapshot {
	gpus := make([]GpuSnapshot, 0, len(lines))

	for _, line := range lines {
		cells := splitCsvTrim(line)
		if len(cells) < 5 {
			continue
		}

		index, ok := toInt(cells[0])
		if !ok {
			continue
		}

		name := "GPU " + strconv.Itoa(index)
		if cells[1] != "" {
			name = cells[1]
		}

		gpus = append(gpus, GpuSnapshot{
			Index:           index,
			Name:            name,
			Utilization:     toNumberPtr(cellAt(cells, 2)),
			MemoryUsedMb:    toNumberPtr(cellAt(cells, 3)),
			MemoryTotalMb:   toNumberPtr(cellAt(cells, 4)),
			Temperature:     toNumberPtr(cellAt(cells, 5)),
			PowerDrawWatts:  toNumberPtr(cellAt(cells, 6)),
			PowerLimitWatts: toNumberPtr(cellAt(cells, 7)),
			Processes:       []GpuProcess{},
		})
	}

	return gpus
}

// attachGpuProcesses mirrors attachGpuProcesses in host-metrics.ts: compute
// processes are keyed by GPU UUID (not index), so distinct UUIDs are mapped
// onto gpus in first-seen order, matching nvidia-smi's stable index
// ordering.
func attachGpuProcesses(gpus []GpuSnapshot, lines []string) {
	if len(gpus) == 0 {
		return
	}

	var uuidOrder []string
	uuidIndex := make(map[string]int)

	for _, line := range lines {
		cells := splitCsvTrim(line)
		if len(cells) < 2 {
			continue
		}

		uuid := cells[0]
		pid, ok := toInt(cellAt(cells, 1))
		if uuid == "" || !ok {
			continue
		}

		idx, seen := uuidIndex[uuid]
		if !seen {
			idx = len(uuidOrder)
			uuidOrder = append(uuidOrder, uuid)
			uuidIndex[uuid] = idx
		}

		if idx >= len(gpus) {
			continue
		}

		var name *string
		if n := cellAt(cells, 3); n != "" {
			nameCopy := n
			name = &nameCopy
		}

		gpus[idx].Processes = append(gpus[idx].Processes, GpuProcess{
			PID:          pid,
			MemoryUsedMb: toNumberPtr(cellAt(cells, 2)),
			Name:         name,
		})
	}
}

// parseCpuRows mirrors parseCpuRows in host-metrics.ts: /proc/loadavg's
// "0.52 0.58 0.59 2/1234 56789" line (identified by its 4th field containing
// a "/"), plus a bare `nproc` line.
func parseCpuRows(lines []string) (*[3]float64, *int) {
	var loadAverage *[3]float64
	var cpuCount *int

	for _, line := range lines {
		cells := strings.Fields(strings.TrimSpace(line))
		if len(cells) >= 4 && strings.Contains(cells[3], "/") {
			one, ok1 := toFloat(cells[0])
			five, ok2 := toFloat(cells[1])
			fifteen, ok3 := toFloat(cells[2])
			if ok1 && ok2 && ok3 {
				value := [3]float64{one, five, fifteen}
				loadAverage = &value
			}
			continue
		}

		if len(cells) == 1 {
			if n, ok := toInt(cells[0]); ok {
				cpuCount = &n
			}
		}
	}

	return loadAverage, cpuCount
}

// parseMemoryRows mirrors parseMemoryRows in host-metrics.ts: converts
// /proc/meminfo's kB fields to MiB, rounding, and returns nil unless both
// MemTotal and MemAvailable were found.
func parseMemoryRows(lines []string) *MemoryUsage {
	var totalKb, availableKb *float64

	for _, line := range lines {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		label, value := fields[0], fields[1]
		parsed, ok := toFloat(value)
		if !ok {
			continue
		}

		switch label {
		case "MemTotal:":
			totalKb = &parsed
		case "MemAvailable:":
			availableKb = &parsed
		}
	}

	if totalKb == nil || availableKb == nil {
		return nil
	}

	return &MemoryUsage{
		TotalMb:     roundKbToMb(*totalKb),
		AvailableMb: roundKbToMb(*availableKb),
	}
}

// parseDiskRow mirrors parseDiskRow in host-metrics.ts: the last `df -Pk`
// line (POSIX mode keeps long device names on one line), fields
// filesystem/total/used/available/pct/mountpoint.
func parseDiskRow(lines []string) *DiskUsage {
	if len(lines) == 0 {
		return nil
	}
	line := lines[len(lines)-1]

	cells := strings.Fields(strings.TrimSpace(line))
	if len(cells) < 6 {
		return nil
	}

	totalKb, ok1 := toFloat(cells[1])
	availableKb, ok2 := toFloat(cells[3])
	if !ok1 || !ok2 {
		return nil
	}

	return &DiskUsage{
		MountPath:   cells[5],
		TotalMb:     roundKbToMb(totalKb),
		AvailableMb: roundKbToMb(availableKb),
	}
}

func roundKbToMb(kb float64) int64 {
	if kb >= 0 {
		return int64(kb/1024 + 0.5)
	}
	return int64(kb/1024 - 0.5)
}

func splitCsvTrim(line string) []string {
	rawCells := strings.Split(line, ",")
	cells := make([]string, len(rawCells))
	for i, cell := range rawCells {
		cells[i] = strings.TrimSpace(cell)
	}
	return cells
}

func cellAt(cells []string, index int) string {
	if index < 0 || index >= len(cells) {
		return ""
	}
	return cells[index]
}

// toNumber mirrors toNumber in host-metrics.ts: nvidia-smi's "[N/A]"/
// "[Not Supported]" cells (anything starting with "[") and empty cells parse
// to "missing" rather than 0.
func toNumberPtr(value string) *float64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.HasPrefix(trimmed, "[") {
		return nil
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

func toFloat(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.HasPrefix(trimmed, "[") {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func toInt(value string) (int, bool) {
	f, ok := toFloat(value)
	if !ok {
		return 0, false
	}
	return int(f), true
}

// ExecFunc runs command over an SSH exec channel and returns its stdout,
// exit code, and any transport-level error (a non-zero exit code is not
// itself an error - the metrics command already guards every probe with
// `|| true`, so a non-zero exit here would indicate something unexpected,
// but callers are not required to treat it specially).
type ExecFunc func(command string) (stdout string, exitCode int, err error)

// Collect runs BuildMetricsCommand/ParseMetricsOutput once, synchronously.
// Mirrors collectHostMetrics in ssh-session.ts (the one-shot
// refreshHostMetrics path, no polling).
func Collect(exec ExecFunc, workspacePath string) (Snapshot, error) {
	stdout, _, err := exec(BuildMetricsCommand(workspacePath))
	if err != nil {
		return Snapshot{}, err
	}
	return ParseMetricsOutput(stdout, time.Now().UnixMilli()), nil
}

// Poller runs Collect on a repeating "poll, then schedule next run from
// completion time" loop (not a fixed-rate ticker), mirroring
// runHostMetricsPoll/scheduleHostMetricsPoll in ssh-session.ts: a slow or
// stalled host never gets overlapping exec channels queued against it.
type Poller struct {
	exec       ExecFunc
	onSnapshot func(Snapshot)
	onError    func(error)

	mu            sync.Mutex
	workspacePath string
	intervalMs    int
	timer         *time.Timer
	generation    int // bumped by Stop/Start so a racing timer callback can recognize it's stale
	running       bool
}

// NewPoller creates a Poller. onSnapshot/onError are called from a
// background goroutine and must be safe to call concurrently with the
// caller's own code (the same requirement ssh-session.ts's emitHostMetricsEvent
// callback pattern has via its listener Set).
func NewPoller(exec ExecFunc, onSnapshot func(Snapshot), onError func(error)) *Poller {
	return &Poller{exec: exec, onSnapshot: onSnapshot, onError: onError}
}

// Start begins polling workspacePath every intervalMs (clamped to
// MinIntervalMs) until Stop is called. Calling Start again while already
// running mirrors startHostMetrics's "already have a poller -> just update
// its interval/workspacePath in place" behavior, rather than starting a
// second concurrent loop.
func (p *Poller) Start(workspacePath string, intervalMs int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	normalized := intervalMs
	if normalized <= 0 {
		normalized = DefaultIntervalMs
	}
	if normalized < MinIntervalMs {
		normalized = MinIntervalMs
	}

	if p.running {
		p.intervalMs = normalized
		p.workspacePath = workspacePath
		return
	}

	p.running = true
	p.intervalMs = normalized
	p.workspacePath = workspacePath
	p.generation++
	gen := p.generation

	go p.poll(gen)
}

// Stop halts the polling loop. Safe to call even if not running.
func (p *Poller) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.running = false
	p.generation++
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
}

func (p *Poller) poll(gen int) {
	p.mu.Lock()
	if !p.running || p.generation != gen {
		p.mu.Unlock()
		return
	}
	workspacePath := p.workspacePath
	p.mu.Unlock()

	snapshot, err := Collect(p.exec, workspacePath)

	p.mu.Lock()
	stillCurrent := p.running && p.generation == gen
	interval := p.intervalMs
	p.mu.Unlock()

	if stillCurrent {
		if err != nil {
			if p.onError != nil {
				p.onError(err)
			}
		} else if p.onSnapshot != nil {
			p.onSnapshot(snapshot)
		}
	}

	p.mu.Lock()
	if !p.running || p.generation != gen {
		p.mu.Unlock()
		return
	}
	p.timer = time.AfterFunc(time.Duration(interval)*time.Millisecond, func() {
		p.poll(gen)
	})
	p.mu.Unlock()
}
