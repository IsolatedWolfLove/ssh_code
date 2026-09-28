package hostmetrics

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// sampleOutput mirrors SAMPLE_OUTPUT in host-metrics.test.ts exactly, so the
// parsing assertions below are a direct port of that file's fixtures.
const sampleOutput = "###SSHSTUDIO:GPU\n" +
	"0, NVIDIA GeForce RTX 4090, 97, 21311, 24564, 71, 412.55, 450.00\n" +
	"1, NVIDIA GeForce RTX 4090, 0, 3, 24564, 34, [N/A], [N/A]\n" +
	"###SSHSTUDIO:GPUPROC\n" +
	"GPU-1111, 40321, 20984, python\n" +
	"GPU-1111, 40988, 128, /usr/bin/Xvfb\n" +
	"GPU-2222, 51002, 2, python\n" +
	"###SSHSTUDIO:CPU\n" +
	"12.40 9.80 6.31 14/2841 91234\n" +
	"32\n" +
	"###SSHSTUDIO:MEM\n" +
	"MemTotal: 131980000\n" +
	"MemAvailable: 42990000\n" +
	"###SSHSTUDIO:DISK\n" +
	"/dev/nvme0n1p2 1922728840 1633203292 191725160 90% /"

func floatPtr(v float64) *float64 { return &v }

func TestBuildMetricsCommand(t *testing.T) {
	t.Run("reports free space for the open workspace and quotes the path", func(t *testing.T) {
		command := BuildMetricsCommand("/home/dev/it's runs")
		want := `df -Pk '/home/dev/it'\''s runs'`
		if !strings.Contains(command, want) {
			t.Fatalf("command = %q, want substring %q", command, want)
		}
	})

	t.Run("falls back to the root filesystem when no workspace is open", func(t *testing.T) {
		command := BuildMetricsCommand("")
		if !strings.Contains(command, "df -Pk '/'") {
			t.Fatalf("command = %q, want substring df -Pk '/'", command)
		}
	})

	t.Run("guards the GPU probes so CPU-only hosts still report", func(t *testing.T) {
		command := BuildMetricsCommand("/")
		if !strings.Contains(command, "command -v nvidia-smi") {
			t.Fatalf("command = %q, want substring `command -v nvidia-smi`", command)
		}
	})
}

func TestParseMetricsOutput(t *testing.T) {
	t.Run("reads per-GPU utilisation, memory, temperature and power", func(t *testing.T) {
		snapshot := ParseMetricsOutput(sampleOutput, 1767225600000)

		if snapshot.CollectedAt != 1767225600000 {
			t.Fatalf("CollectedAt = %d, want 1767225600000", snapshot.CollectedAt)
		}
		if !snapshot.GpuAvailable {
			t.Fatal("GpuAvailable = false, want true")
		}
		if len(snapshot.Gpus) != 2 {
			t.Fatalf("len(Gpus) = %d, want 2", len(snapshot.Gpus))
		}

		gpu0 := snapshot.Gpus[0]
		if gpu0.Index != 0 || gpu0.Name != "NVIDIA GeForce RTX 4090" {
			t.Fatalf("gpu0 = %+v", gpu0)
		}
		assertFloatPtr(t, "gpu0.Utilization", gpu0.Utilization, 97)
		assertFloatPtr(t, "gpu0.MemoryUsedMb", gpu0.MemoryUsedMb, 21311)
		assertFloatPtr(t, "gpu0.MemoryTotalMb", gpu0.MemoryTotalMb, 24564)
		assertFloatPtr(t, "gpu0.Temperature", gpu0.Temperature, 71)
		assertFloatPtr(t, "gpu0.PowerDrawWatts", gpu0.PowerDrawWatts, 412.55)
		assertFloatPtr(t, "gpu0.PowerLimitWatts", gpu0.PowerLimitWatts, 450)
	})

	t.Run("treats unsupported driver fields as missing rather than zero", func(t *testing.T) {
		snapshot := ParseMetricsOutput(sampleOutput, 0)
		gpu1 := snapshot.Gpus[1]
		if gpu1.PowerDrawWatts != nil {
			t.Fatalf("gpu1.PowerDrawWatts = %v, want nil", *gpu1.PowerDrawWatts)
		}
		if gpu1.PowerLimitWatts != nil {
			t.Fatalf("gpu1.PowerLimitWatts = %v, want nil", *gpu1.PowerLimitWatts)
		}
		assertFloatPtr(t, "gpu1.Utilization", gpu1.Utilization, 0)
	})

	t.Run("attributes compute processes to the right GPU", func(t *testing.T) {
		snapshot := ParseMetricsOutput(sampleOutput, 0)

		gpu0Procs := snapshot.Gpus[0].Processes
		if len(gpu0Procs) != 2 {
			t.Fatalf("len(gpu0.Processes) = %d, want 2", len(gpu0Procs))
		}
		if gpu0Procs[0].PID != 40321 || gpu0Procs[0].Name == nil || *gpu0Procs[0].Name != "python" {
			t.Fatalf("gpu0.Processes[0] = %+v", gpu0Procs[0])
		}
		assertFloatPtr(t, "gpu0.Processes[0].MemoryUsedMb", gpu0Procs[0].MemoryUsedMb, 20984)
		if gpu0Procs[1].PID != 40988 || gpu0Procs[1].Name == nil || *gpu0Procs[1].Name != "/usr/bin/Xvfb" {
			t.Fatalf("gpu0.Processes[1] = %+v", gpu0Procs[1])
		}

		gpu1Procs := snapshot.Gpus[1].Processes
		if len(gpu1Procs) != 1 || gpu1Procs[0].PID != 51002 {
			t.Fatalf("gpu1.Processes = %+v", gpu1Procs)
		}
		assertFloatPtr(t, "gpu1.Processes[0].MemoryUsedMb", gpu1Procs[0].MemoryUsedMb, 2)
	})

	t.Run("reads load, cpu count, memory and disk in mebibytes", func(t *testing.T) {
		snapshot := ParseMetricsOutput(sampleOutput, 0)

		if snapshot.LoadAverage == nil {
			t.Fatal("LoadAverage = nil, want a value")
		}
		want := [3]float64{12.4, 9.8, 6.31}
		if *snapshot.LoadAverage != want {
			t.Fatalf("LoadAverage = %v, want %v", *snapshot.LoadAverage, want)
		}
		if snapshot.CpuCount == nil || *snapshot.CpuCount != 32 {
			t.Fatalf("CpuCount = %v, want 32", snapshot.CpuCount)
		}
		if snapshot.Memory == nil || snapshot.Memory.TotalMb != 128887 || snapshot.Memory.AvailableMb != 41982 {
			t.Fatalf("Memory = %+v, want {128887 41982}", snapshot.Memory)
		}
		if snapshot.Disk == nil || snapshot.Disk.MountPath != "/" || snapshot.Disk.TotalMb != 1877665 || snapshot.Disk.AvailableMb != 187232 {
			t.Fatalf("Disk = %+v, want {/ 1877665 187232}", snapshot.Disk)
		}
	})

	t.Run("reports gpuAvailable false on hosts without nvidia-smi", func(t *testing.T) {
		stdout := strings.Join([]string{
			"###SSHSTUDIO:GPU",
			"###SSHSTUDIO:GPUPROC",
			"###SSHSTUDIO:CPU",
			"0.10 0.20 0.30 1/200 400",
			"8",
			"###SSHSTUDIO:MEM",
			"MemTotal: 16000000",
			"MemAvailable: 8000000",
			"###SSHSTUDIO:DISK",
			"/dev/sda1 100000000 50000000 50000000 50% /data",
		}, "\n")

		snapshot := ParseMetricsOutput(stdout, 0)

		if snapshot.GpuAvailable {
			t.Fatal("GpuAvailable = true, want false")
		}
		if len(snapshot.Gpus) != 0 {
			t.Fatalf("Gpus = %+v, want empty", snapshot.Gpus)
		}
		if snapshot.CpuCount == nil || *snapshot.CpuCount != 8 {
			t.Fatalf("CpuCount = %v, want 8", snapshot.CpuCount)
		}
		if snapshot.Disk == nil || snapshot.Disk.MountPath != "/data" {
			t.Fatalf("Disk = %+v, want MountPath /data", snapshot.Disk)
		}
	})

	t.Run("survives a host where every probe is missing", func(t *testing.T) {
		snapshot := ParseMetricsOutput("", 0)

		if len(snapshot.Gpus) != 0 {
			t.Fatalf("Gpus = %+v, want empty", snapshot.Gpus)
		}
		if snapshot.LoadAverage != nil {
			t.Fatalf("LoadAverage = %v, want nil", snapshot.LoadAverage)
		}
		if snapshot.Memory != nil {
			t.Fatalf("Memory = %v, want nil", snapshot.Memory)
		}
		if snapshot.Disk != nil {
			t.Fatalf("Disk = %v, want nil", snapshot.Disk)
		}
	})
}

func assertFloatPtr(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s = nil, want %v", name, want)
	}
	if *got != want {
		t.Fatalf("%s = %v, want %v", name, *got, want)
	}
}

func TestCollect(t *testing.T) {
	exec := func(command string) (string, int, error) {
		if !strings.Contains(command, "nvidia-smi") {
			t.Fatalf("command missing nvidia-smi probe: %q", command)
		}
		return sampleOutput, 0, nil
	}

	snapshot, err := Collect(exec, "/workspace")
	if err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	if !snapshot.GpuAvailable || len(snapshot.Gpus) != 2 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestCollectPropagatesExecError(t *testing.T) {
	exec := func(command string) (string, int, error) {
		return "", -1, errors.New("boom")
	}

	_, err := Collect(exec, "/workspace")
	if err == nil {
		t.Fatal("Collect() error = nil, want an error")
	}
}

func TestPollerPollsAndStops(t *testing.T) {
	var mu sync.Mutex
	var calls int
	execDone := make(chan struct{}, 100)

	exec := func(command string) (string, int, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		execDone <- struct{}{}
		return sampleOutput, 0, nil
	}

	snapshots := make(chan Snapshot, 100)
	poller := NewPoller(exec, func(s Snapshot) { snapshots <- s }, func(err error) {
		t.Errorf("unexpected error: %v", err)
	})

	poller.Start("/workspace", 30) // below MinIntervalMs, should clamp up but still be fast enough for the test

	// Wait for at least 2 polls, then stop.
	for i := 0; i < 2; i++ {
		select {
		case <-execDone:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for poll #%d", i+1)
		}
	}

	poller.Stop()

	mu.Lock()
	callsAtStop := calls
	mu.Unlock()

	// Drain any snapshot already queued so the channel doesn't block future
	// sends, then confirm no further exec calls happen after a bit.
	drainTimeout := time.After(50 * time.Millisecond)
drain:
	for {
		select {
		case <-snapshots:
		case <-drainTimeout:
			break drain
		}
	}

	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	callsAfterWait := calls
	mu.Unlock()

	if callsAfterWait != callsAtStop {
		t.Fatalf("calls grew after Stop(): %d -> %d", callsAtStop, callsAfterWait)
	}
}

// TestPollerDoesNotOverlapSlowExec directly exercises the "poll, then
// schedule the next run from completion time" semantics found in
// runHostMetricsPoll/scheduleHostMetricsPoll: the fake exec here sleeps far
// longer than the polling interval, so a fixed-rate ticker implementation
// would let calls pile up (maxConcurrent > 1), while the actual
// schedule-from-completion implementation never does.
//
// It sets Poller's fields directly (white-box, same package) to bypass
// Start's MinIntervalMs=1000ms clamp, which would otherwise make this
// scenario slow to observe.
func TestPollerDoesNotOverlapSlowExec(t *testing.T) {
	var mu sync.Mutex
	activeCalls := 0
	maxConcurrent := 0
	totalCalls := 0

	exec := func(command string) (string, int, error) {
		mu.Lock()
		activeCalls++
		totalCalls++
		if activeCalls > maxConcurrent {
			maxConcurrent = activeCalls
		}
		mu.Unlock()

		time.Sleep(40 * time.Millisecond) // much longer than the 10ms interval below

		mu.Lock()
		activeCalls--
		mu.Unlock()
		return sampleOutput, 0, nil
	}

	poller := &Poller{}
	*poller = *NewPoller(exec, func(Snapshot) {}, func(err error) {
		t.Errorf("unexpected error: %v", err)
	})

	poller.mu.Lock()
	poller.intervalMs = 10
	poller.workspacePath = "/workspace"
	poller.running = true
	poller.generation++
	gen := poller.generation
	poller.mu.Unlock()

	go poller.poll(gen)

	time.Sleep(150 * time.Millisecond)
	poller.Stop()

	mu.Lock()
	defer mu.Unlock()
	if maxConcurrent > 1 {
		t.Fatalf("maxConcurrent = %d, want at most 1 (exec calls overlapped)", maxConcurrent)
	}
	if totalCalls < 2 {
		t.Fatalf("totalCalls = %d, want at least 2 polls within 150ms", totalCalls)
	}
}

func TestPollerRestartUpdatesIntervalInPlace(t *testing.T) {
	exec := func(command string) (string, int, error) {
		return sampleOutput, 0, nil
	}

	poller := NewPoller(exec, func(Snapshot) {}, func(error) {})
	poller.Start("/a", 1000)
	poller.mu.Lock()
	firstGen := poller.generation
	poller.mu.Unlock()

	// Calling Start again while running should update in place, not start a
	// second concurrent loop (mirrors startHostMetrics's early-return branch
	// when this.hostMetricsPoller already exists).
	poller.Start("/b", 5000)
	poller.mu.Lock()
	secondGen := poller.generation
	workspacePath := poller.workspacePath
	interval := poller.intervalMs
	poller.mu.Unlock()

	if secondGen != firstGen {
		t.Fatalf("generation changed on in-place update: %d -> %d", firstGen, secondGen)
	}
	if workspacePath != "/b" || interval != 5000 {
		t.Fatalf("workspacePath/intervalMs = %q/%d, want /b/5000", workspacePath, interval)
	}

	poller.Stop()
}
