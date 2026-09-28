package idletransfer

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeSource is an in-memory Source for manager tests: no real SFTP client,
// no real network I/O, just a map of remote paths to fake directory
// listings/content sizes.
type fakeSource struct {
	mu      sync.Mutex
	dirs    map[string][]RemoteEntry
	stats   map[string]Stat
	fetches []string // records every remotePath Fetch was called with
}

func newFakeSource() *fakeSource {
	return &fakeSource{dirs: make(map[string][]RemoteEntry), stats: make(map[string]Stat)}
}

func (f *fakeSource) Stat(remotePath string) (Stat, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stats[remotePath], nil
}

func (f *fakeSource) ReadDir(remotePath string) ([]RemoteEntry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dirs[remotePath], nil
}

func (f *fakeSource) Fetch(remotePath, localPath string, onProgress func(chunkBytes int)) error {
	f.mu.Lock()
	f.fetches = append(f.fetches, remotePath)
	size := f.stats[remotePath].Size
	f.mu.Unlock()

	if onProgress != nil && size > 0 {
		onProgress(int(size))
	}
	return os.WriteFile(localPath, make([]byte, size), 0o644)
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", timeout)
}

// zeroPacingGovernor is already-quiet (no foreground ops, lastForeground far
// in the past) with a no-op sleep, so WaitForAllowance grants every request
// near-instantly - used for the one true end-to-end test below where a real
// worker goroutine must run to completion quickly.
func zeroPacingGovernor() *Governor {
	g := NewGovernor()
	g.lastForeground = g.now().Add(-time.Hour)
	g.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
	return g
}

func TestManager_QueueSingleFileDownload(t *testing.T) {
	source := newFakeSource()
	source.stats["/remote/photo.png"] = Stat{Size: 1024}

	m := NewManager(source, DefaultCacheLimitBytes)
	m.governor = zeroPacingGovernor()
	if err := m.StartSession(); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	defer m.StopSession()

	localDir := t.TempDir()
	localPath := filepath.Join(localDir, "photo.png")

	if _, err := m.QueueIdleDownload("/remote/photo.png", localPath); err != nil {
		t.Fatalf("QueueIdleDownload: %v", err)
	}

	waitFor(t, 2*time.Second, func() bool {
		_, err := os.Stat(localPath)
		return err == nil
	})

	data, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatalf("expected downloaded file to exist: %v", err)
	}
	if len(data) != 1024 {
		t.Errorf("downloaded file size = %d, want 1024", len(data))
	}

	waitFor(t, time.Second, func() bool {
		s := m.Snapshot()
		return s.QueuedItems == 0 && s.ActivePath == ""
	})
}

// TestManager_CancelDownloadRemovesFromQueue exercises CancelDownload's
// bookkeeping directly against a manually-seeded queue (via the unexported
// enqueue, same package) rather than going through QueueIdleDownload's
// governor-gated entry point - that gate blocks synchronously on the
// caller's goroutine (mirrors queueManualDownload's `await
// waitUntilIdle(signal)` in idle-transfer.ts), so driving it with a
// permanently-busy fake governor would hang the test itself rather than
// just slow the background worker.
func TestManager_CancelDownloadRemovesFromQueue(t *testing.T) {
	m := NewManager(newFakeSource(), DefaultCacheLimitBytes)

	m.enqueue(&transferItem{remotePath: "/remote/a.png", localPath: "/tmp/idletransfer-a.png", size: 10, groupPath: "/remote/a.png"})
	m.enqueue(&transferItem{remotePath: "/remote/b.png", localPath: "/tmp/idletransfer-b.png", size: 10, groupPath: "/remote/b.png"})

	snapshot := m.CancelDownload("/remote/a.png")
	if snapshot.QueuedItems != 1 {
		t.Errorf("QueuedItems = %d after canceling one of two, want 1", snapshot.QueuedItems)
	}
	for _, p := range snapshot.QueuedPaths {
		if p == "/remote/a.png" {
			t.Errorf("canceled path %q still present in QueuedPaths", p)
		}
	}

	m.mu.Lock()
	reserved := m.reservedCacheBytes
	m.mu.Unlock()
	if reserved != 0 {
		t.Errorf("reservedCacheBytes = %d after canceling a non-cache item, want 0 (unaffected)", reserved)
	}
}

// TestManager_CancelGroupRemovesAllMembers mirrors the above: seeds the
// queue directly rather than racing a background worker.
func TestManager_CancelGroupRemovesAllMembers(t *testing.T) {
	m := NewManager(newFakeSource(), DefaultCacheLimitBytes)

	m.enqueue(&transferItem{remotePath: "/remote/dir/one.txt", localPath: "/tmp/one.txt", size: 5, groupPath: "/remote/dir"})
	m.enqueue(&transferItem{remotePath: "/remote/dir/two.txt", localPath: "/tmp/two.txt", size: 5, groupPath: "/remote/dir"})
	m.enqueue(&transferItem{remotePath: "/remote/other.txt", localPath: "/tmp/other.txt", size: 5, groupPath: "/remote/other.txt"})

	snapshot := m.CancelGroup("/remote/dir")
	if snapshot.QueuedItems != 1 {
		t.Errorf("QueuedItems = %d after group cancel, want 1 (only /remote/other.txt left)", snapshot.QueuedItems)
	}
	for _, group := range snapshot.ManualGroups {
		if group.RootPath == "/remote/dir" {
			t.Errorf("group %q should have been fully removed, still present: %+v", "/remote/dir", group)
		}
	}
}

func TestManager_StartAutomaticMediaCache_RespectsCacheLimit(t *testing.T) {
	source := newFakeSource()
	source.dirs["/remote/media"] = []RemoteEntry{
		{Name: "big.png", Path: "/remote/media/big.png", Size: 100},
		{Name: "small.png", Path: "/remote/media/small.png", Size: 10},
		{Name: "skip.txt", Path: "/remote/media/skip.txt", Size: 10}, // not a media extension
	}

	// Fetch() writes stats[remotePath].Size bytes, independently of the
	// RemoteEntry.Size used by the directory scan; both must agree or the
	// post-fetch byte-count check in transferFile fails and the item is
	// treated as a failed transfer (never counted into CachedBytes).
	source.stats["/remote/media/big.png"] = Stat{Size: 100}
	source.stats["/remote/media/small.png"] = Stat{Size: 10}

	const tinyLimit = int64(50) // smaller than big.png alone
	m := NewManager(source, tinyLimit)
	m.governor = zeroPacingGovernor()
	if err := m.StartSession(); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	defer m.StopSession()

	m.StartAutomaticMediaCache("/remote/media")

	waitFor(t, 2*time.Second, func() bool {
		s := m.Snapshot()
		return s.QueuedItems == 0 && s.ActivePath == "" && s.CachedBytes > 0
	})

	snapshot := m.Snapshot()
	if snapshot.CachedBytes > tinyLimit {
		t.Errorf("CachedBytes = %d, exceeds cache limit %d", snapshot.CachedBytes, tinyLimit)
	}
	if snapshot.CachedBytes != 10 {
		t.Errorf("CachedBytes = %d, want 10 (only small.png fits under the %d-byte cap)", snapshot.CachedBytes, tinyLimit)
	}

	source.mu.Lock()
	fetchedBig := false
	for _, p := range source.fetches {
		if p == "/remote/media/big.png" {
			fetchedBig = true
		}
	}
	source.mu.Unlock()
	if fetchedBig {
		t.Error("big.png should have been skipped: it alone exceeds the cache limit")
	}
}

func TestManager_ReadCached_MissWhenNeverCached(t *testing.T) {
	source := newFakeSource()
	m := NewManager(source, DefaultCacheLimitBytes)

	if _, ok := m.ReadCached("/remote/nope.png", 10, nil); ok {
		t.Error("ReadCached should miss for a path never cached")
	}
}

func TestManager_QueueIdleDownload_NoSessionErrors(t *testing.T) {
	source := newFakeSource()
	m := NewManager(source, DefaultCacheLimitBytes)
	// Deliberately do not call StartSession().

	if _, err := m.QueueIdleDownload("/remote/a.png", "/tmp/a.png"); err == nil {
		t.Error("QueueIdleDownload without an active session should error")
	}
}
