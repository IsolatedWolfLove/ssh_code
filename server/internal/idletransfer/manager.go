package idletransfer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// DefaultCacheLimitBytes mirrors DEFAULT_CACHE_LIMIT_BYTES in
// idle-transfer.ts (3 GiB).
const DefaultCacheLimitBytes int64 = 3 * 1024 * 1024 * 1024

// MaxAutomaticScanEntries mirrors MAX_AUTOMATIC_SCAN_ENTRIES.
const MaxAutomaticScanEntries = 20_000

// mediaExtensions mirrors MEDIA_EXTENSIONS: the automatic background cache
// only ever prefetches files with one of these extensions.
var mediaExtensions = map[string]bool{
	".apng": true, ".avif": true, ".bmp": true, ".gif": true,
	".heic": true, ".heif": true, ".jpeg": true, ".jpg": true,
	".mkv": true, ".mov": true, ".mp4": true, ".mpeg": true,
	".mpg": true, ".png": true, ".svg": true, ".webm": true, ".webp": true,
}

// RemoteEntry mirrors IdleRemoteEntry: the minimal directory-listing shape
// Manager needs from whatever remote filesystem source it's fed.
type RemoteEntry struct {
	Name       string
	Path       string
	IsDir      bool
	Size       int64
	ModifiedAt *int64 // ms since epoch, mirrors the optional modifiedAt
}

// Stat mirrors the {kind, size, modifiedAt} shape IdleTransferSource.stat
// returns.
type Stat struct {
	IsDir      bool
	Size       int64
	ModifiedAt *int64
}

// Source is everything Manager needs from the remote filesystem, injected
// so this package has no dependency on any specific SFTP client type -
// mirrors the sibling forks' ExecFunc-style decoupling (hostmetrics,
// search). The integration layer satisfies this with thin wrappers around
// internal/sftp's ReadDir/Stat and a streaming download (e.g.
// internal/sftp.DownloadFile, or a raw SFTP Open) for Fetch.
type Source interface {
	Stat(remotePath string) (Stat, error)
	ReadDir(remotePath string) ([]RemoteEntry, error)
	// Fetch copies remotePath's content to localPath, calling onProgress
	// with each chunk's byte count as it's written (mirrors
	// createReadStream + the governed pipeline in transferFile). Fetch
	// itself does not need to apply any pacing - Manager's worker loop
	// calls Governor.WaitForAllowance per chunk via onProgress, exactly
	// like ssh-session.ts's `limiter` Transform stream does - so Fetch's
	// job is only to move bytes and report how many moved.
	Fetch(remotePath, localPath string, onProgress func(chunkBytes int)) error
}

// Snapshot mirrors contracts.ts's IdleTransferSnapshot.
type Snapshot struct {
	QueuedItems     int      `json:"queuedItems"`
	QueuedPaths     []string `json:"queuedPaths"`
	ActivePath      string   `json:"activePath"` // "" means none, mirrors the optional activePath
	CachedBytes     int64    `json:"cachedBytes"`
	CacheLimitBytes int64    `json:"cacheLimitBytes"`
	ManualGroups    []Group  `json:"manualGroups"`
}

// Group mirrors contracts.ts's IdleTransferGroup.
type Group struct {
	RootPath    string   `json:"rootPath"`
	ActivePath  string   `json:"activePath"` // "" means none
	QueuedPaths []string `json:"queuedPaths"`
}

type cacheRecord struct {
	localPath  string
	size       int64
	modifiedAt *int64
}

type transferItem struct {
	remotePath string
	localPath  string
	size       int64
	modifiedAt *int64
	cache      bool
	groupPath  string // "" means none, mirrors the optional groupPath
}

// Manager is the Go port of IdleTransferManager.
type Manager struct {
	source          Source
	cacheLimitBytes int64
	governor        *Governor

	mu                      sync.Mutex
	cacheDir                string
	cacheRecords            map[string]cacheRecord
	cachedBytes             int64
	reservedCacheBytes      int64
	queue                   []*transferItem
	queuedPaths             map[string]bool
	sessionCtx              context.Context
	sessionCancel           context.CancelFunc
	activeCancel            context.CancelFunc
	workerRunning           bool
	activePath              string
	activeItem              *transferItem
	automaticScanGeneration int
	workerDone              chan struct{}
}

// NewManager creates a Manager. cacheLimitBytes is clamped the same way the
// TS constructor does: at least 1 byte, at most DefaultCacheLimitBytes.
func NewManager(source Source, cacheLimitBytes int64) *Manager {
	if cacheLimitBytes > DefaultCacheLimitBytes {
		cacheLimitBytes = DefaultCacheLimitBytes
	}
	if cacheLimitBytes < 1 {
		cacheLimitBytes = 1
	}
	return &Manager{
		source:          source,
		cacheLimitBytes: cacheLimitBytes,
		governor:        NewGovernor(),
		cacheRecords:    make(map[string]cacheRecord),
		queuedPaths:     make(map[string]bool),
	}
}

// Governor exposes the Manager's bandwidth governor, mirroring the
// `readonly governor` field ssh-session.ts reaches into directly for
// beginForeground/noteForegroundActivity around foreground file
// operations.
func (m *Manager) Governor() *Governor {
	return m.governor
}

// StartSession mirrors startSession(): tears down any previous session,
// then opens a fresh temp cache directory for automatic media previews.
func (m *Manager) StartSession() error {
	m.StopSession()

	dir, err := os.MkdirTemp("", "ssh-studio-preview-")
	if err != nil {
		return fmt.Errorf("unable to create idle-transfer cache directory: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	m.mu.Lock()
	m.sessionCtx = ctx
	m.sessionCancel = cancel
	m.cacheDir = dir
	m.mu.Unlock()

	return nil
}

// StopSession mirrors stopSession(): cancels any in-flight transfer,
// drains the worker, clears all queue/cache state, and removes the temp
// cache directory.
func (m *Manager) StopSession() {
	m.mu.Lock()
	m.automaticScanGeneration++
	if m.sessionCancel != nil {
		m.sessionCancel()
	}
	m.sessionCtx = nil
	m.sessionCancel = nil
	if m.activeCancel != nil {
		m.activeCancel()
	}
	done := m.workerDone
	m.queue = nil
	m.queuedPaths = make(map[string]bool)
	m.mu.Unlock()

	if done != nil {
		<-done
	}

	m.mu.Lock()
	m.activePath = ""
	m.cacheRecords = make(map[string]cacheRecord)
	m.cachedBytes = 0
	m.reservedCacheBytes = 0
	dir := m.cacheDir
	m.cacheDir = ""
	m.mu.Unlock()

	if dir != "" {
		_ = os.RemoveAll(dir)
	}
}

// Snapshot mirrors snapshot().
func (m *Manager) Snapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) snapshotLocked() Snapshot {
	groups := make(map[string]*Group)
	order := []string{}
	addToGroup := func(item *transferItem, active bool) {
		if item.cache || item.groupPath == "" {
			return
		}
		group, ok := groups[item.groupPath]
		if !ok {
			group = &Group{RootPath: item.groupPath, QueuedPaths: []string{}}
			groups[item.groupPath] = group
			order = append(order, item.groupPath)
		}
		if active {
			group.ActivePath = item.remotePath
		} else {
			group.QueuedPaths = append(group.QueuedPaths, item.remotePath)
		}
	}

	queuedPaths := make([]string, 0, len(m.queue))
	for _, item := range m.queue {
		queuedPaths = append(queuedPaths, item.remotePath)
		addToGroup(item, false)
	}
	if m.activeItem != nil {
		addToGroup(m.activeItem, true)
	}

	manualGroups := make([]Group, 0, len(order))
	for _, key := range order {
		manualGroups = append(manualGroups, *groups[key])
	}

	return Snapshot{
		QueuedItems:     len(m.queue),
		QueuedPaths:     queuedPaths,
		ActivePath:      m.activePath,
		CachedBytes:     m.cachedBytes,
		CacheLimitBytes: m.cacheLimitBytes,
		ManualGroups:    manualGroups,
	}
}

// StartAutomaticMediaCache mirrors startAutomaticMediaCache(): replaces the
// automatic media scan with the newly visible workspace, keeping any
// manual downloads already queued.
func (m *Manager) StartAutomaticMediaCache(remoteDirectory string) {
	m.mu.Lock()
	m.automaticScanGeneration++
	generation := m.automaticScanGeneration
	ctx := m.sessionCtx

	var discardedBytes int64
	kept := make([]*transferItem, 0, len(m.queue))
	for _, item := range m.queue {
		if item.cache {
			discardedBytes += item.size
			delete(m.queuedPaths, item.remotePath)
			continue
		}
		kept = append(kept, item)
	}
	m.queue = kept
	m.reservedCacheBytes -= discardedBytes
	if m.reservedCacheBytes < 0 {
		m.reservedCacheBytes = 0
	}
	m.mu.Unlock()

	if ctx == nil {
		return
	}

	go func() {
		_ = m.scanAutomaticDirectory(ctx, remoteDirectory, generation)
	}()
}

// QueueIdleDownload mirrors queueManualDownload(): queues a single file, or
// recursively enqueues a whole directory, for a user-requested background
// download. Blocks briefly (mirrors `await this.waitUntilIdle(signal)`)
// before the initial stat, so a manual queue request itself doesn't
// interrupt foreground activity.
func (m *Manager) QueueIdleDownload(remotePath, localPath string) (Snapshot, error) {
	ctx, err := m.requireSessionCtx()
	if err != nil {
		return Snapshot{}, err
	}

	if err := m.governor.WaitForAllowance(ctx, 1); err != nil {
		return Snapshot{}, err
	}

	stat, err := m.source.Stat(remotePath)
	if err != nil {
		return Snapshot{}, err
	}

	if stat.IsDir {
		if err := m.queueDirectory(ctx, remotePath, localPath, remotePath); err != nil {
			return Snapshot{}, err
		}
	} else {
		m.enqueue(&transferItem{
			remotePath: remotePath,
			localPath:  localPath,
			size:       stat.Size,
			modifiedAt: stat.ModifiedAt,
			cache:      false,
			groupPath:  remotePath,
		})
	}

	m.ensureWorker()
	return m.Snapshot(), nil
}

// CancelDownload mirrors cancel(remotePath): removes every queued item for
// remotePath and, if it's the one actively transferring, cancels it.
func (m *Manager) CancelDownload(remotePath string) Snapshot {
	m.mu.Lock()
	kept := make([]*transferItem, 0, len(m.queue))
	for _, item := range m.queue {
		if item.remotePath == remotePath {
			if item.cache {
				m.reservedCacheBytes -= item.size
				if m.reservedCacheBytes < 0 {
					m.reservedCacheBytes = 0
				}
			}
			delete(m.queuedPaths, item.remotePath)
			continue
		}
		kept = append(kept, item)
	}
	m.queue = kept

	if m.activePath == remotePath && m.activeCancel != nil {
		m.activeCancel()
	}
	snapshot := m.snapshotLocked()
	m.mu.Unlock()
	return snapshot
}

// CancelGroup mirrors cancelGroup(groupPath): cancels every queued (and, if
// applicable, active) item sharing that group's root path.
func (m *Manager) CancelGroup(groupPath string) Snapshot {
	m.mu.Lock()
	targets := make([]string, 0)
	for _, item := range m.queue {
		if item.groupPath == groupPath {
			targets = append(targets, item.remotePath)
		}
	}
	activeMatches := m.activeItem != nil && m.activeItem.groupPath == groupPath
	m.mu.Unlock()

	for _, remotePath := range targets {
		m.CancelDownload(remotePath)
	}

	if activeMatches {
		m.mu.Lock()
		if m.activeCancel != nil {
			m.activeCancel()
		}
		m.mu.Unlock()
	}

	return m.Snapshot()
}

// ReadCached mirrors readCached(): returns the previously cached bytes for
// remotePath if the cache record's size (and, when known, modifiedAt)
// still matches, evicting and returning nil on any mismatch or read
// failure.
func (m *Manager) ReadCached(remotePath string, size int64, modifiedAt *int64) ([]byte, bool) {
	m.mu.Lock()
	record, ok := m.cacheRecords[remotePath]
	m.mu.Unlock()
	if !ok || record.size != size {
		return nil, false
	}
	if modifiedAt != nil && record.modifiedAt != nil && *modifiedAt != *record.modifiedAt {
		return nil, false
	}

	data, err := os.ReadFile(record.localPath)
	if err != nil {
		m.mu.Lock()
		delete(m.cacheRecords, remotePath)
		m.cachedBytes -= record.size
		if m.cachedBytes < 0 {
			m.cachedBytes = 0
		}
		m.mu.Unlock()
		return nil, false
	}
	return data, true
}

// --- internals ---------------------------------------------------------------

var errNoSession = errors.New("no active idle-transfer session")

func (m *Manager) requireSessionCtx() (context.Context, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessionCtx == nil || m.sessionCtx.Err() != nil {
		return nil, errNoSession
	}
	return m.sessionCtx, nil
}

func (m *Manager) scanAutomaticDirectory(ctx context.Context, remoteDirectory string, generation int) error {
	directories := []string{remoteDirectory}
	scannedEntries := 0

	m.mu.Lock()
	reservedBytes := m.cachedBytes + m.reservedCacheBytes
	m.mu.Unlock()

	for len(directories) > 0 && scannedEntries < MaxAutomaticScanEntries {
		m.mu.Lock()
		stillCurrent := generation == m.automaticScanGeneration
		m.mu.Unlock()
		if !stillCurrent || ctx.Err() != nil {
			break
		}

		if err := m.governor.WaitForAllowance(ctx, 1); err != nil {
			return err
		}

		directory := directories[0]
		directories = directories[1:]

		entries, err := m.source.ReadDir(directory)
		if err != nil {
			return err
		}
		scannedEntries += len(entries)

		for _, entry := range entries {
			if entry.IsDir {
				directories = append(directories, entry.Path)
				continue
			}
			ext := strings.ToLower(path.Ext(entry.Name))
			if !mediaExtensions[ext] {
				continue
			}

			size := entry.Size
			if size < 0 {
				size = 0
			}

			m.mu.Lock()
			_, alreadyCached := m.cacheRecords[entry.Path]
			cacheDir := m.cacheDir
			skip := size == 0 || reservedBytes+size > m.cacheLimitBytes || alreadyCached || cacheDir == ""
			if !skip {
				reservedBytes += size
				localName := fmt.Sprintf("%d-%s", len(m.queuedPaths), filepath.Base(entry.Name))
				m.enqueueLocked(&transferItem{
					remotePath: entry.Path,
					localPath:  filepath.Join(cacheDir, localName),
					size:       size,
					modifiedAt: entry.ModifiedAt,
					cache:      true,
				})
			}
			m.mu.Unlock()

			if cacheDir == "" {
				return nil
			}
		}
	}

	m.ensureWorker()
	return nil
}

func (m *Manager) queueDirectory(ctx context.Context, remoteDirectory, localDirectory, groupPath string) error {
	if err := os.MkdirAll(localDirectory, 0o755); err != nil {
		return err
	}

	type pending struct{ remote, local string }
	directories := []pending{{remote: remoteDirectory, local: localDirectory}}

	for len(directories) > 0 {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := m.governor.WaitForAllowance(ctx, 1); err != nil {
			return err
		}

		current := directories[0]
		directories = directories[1:]

		entries, err := m.source.ReadDir(current.remote)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			localEntryPath := filepath.Join(current.local, entry.Name)
			if entry.IsDir {
				if err := os.MkdirAll(localEntryPath, 0o755); err != nil {
					return err
				}
				directories = append(directories, pending{remote: entry.Path, local: localEntryPath})
				continue
			}
			size := entry.Size
			if size < 0 {
				size = 0
			}
			m.enqueue(&transferItem{
				remotePath: entry.Path,
				localPath:  localEntryPath,
				size:       size,
				modifiedAt: entry.ModifiedAt,
				cache:      false,
				groupPath:  groupPath,
			})
		}
	}
	return nil
}

func (m *Manager) enqueue(item *transferItem) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.enqueueLocked(item)
}

// enqueueLocked mirrors enqueue(): de-dupes against what's already queued
// (same remote path, and for non-cache items also the same local path,
// mirroring the original's `item.cache || queued.localPath === item.localPath`
// condition) and against files already cached.
func (m *Manager) enqueueLocked(item *transferItem) {
	for _, queued := range m.queue {
		if queued.remotePath == item.remotePath && (item.cache || queued.localPath == item.localPath) {
			return
		}
	}
	if item.cache {
		if _, ok := m.cacheRecords[item.remotePath]; ok {
			return
		}
	}

	m.queuedPaths[item.remotePath] = true
	m.queue = append(m.queue, item)
	if item.cache {
		m.reservedCacheBytes += item.size
	}
}

func (m *Manager) ensureWorker() {
	m.mu.Lock()
	if m.workerRunning || len(m.queue) == 0 {
		m.mu.Unlock()
		return
	}
	m.workerRunning = true
	done := make(chan struct{})
	m.workerDone = done
	ctx := m.sessionCtx
	m.mu.Unlock()

	if ctx == nil {
		m.mu.Lock()
		m.workerRunning = false
		m.workerDone = nil
		m.mu.Unlock()
		close(done)
		return
	}

	go func() {
		defer close(done)
		m.runWorker(ctx)

		m.mu.Lock()
		m.workerRunning = false
		hasMore := len(m.queue) > 0 && ctx.Err() == nil
		m.mu.Unlock()
		if hasMore {
			m.ensureWorker()
		}
	}()
}

func (m *Manager) runWorker(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}

		m.mu.Lock()
		if len(m.queue) == 0 {
			m.mu.Unlock()
			return
		}
		item := m.queue[0]
		m.queue = m.queue[1:]
		m.activePath = item.remotePath
		m.activeItem = item
		itemCtx, itemCancel := context.WithCancel(ctx)
		m.activeCancel = itemCancel
		m.mu.Unlock()

		err := m.transferFile(itemCtx, item)

		m.mu.Lock()
		if err == nil && item.cache {
			m.reservedCacheBytes -= item.size
			if m.reservedCacheBytes < 0 {
				m.reservedCacheBytes = 0
			}
			m.cacheRecords[item.remotePath] = cacheRecord{
				localPath:  item.localPath,
				size:       item.size,
				modifiedAt: item.modifiedAt,
			}
			m.cachedBytes += item.size
		} else if err != nil && item.cache {
			m.reservedCacheBytes -= item.size
			if m.reservedCacheBytes < 0 {
				m.reservedCacheBytes = 0
			}
		}
		delete(m.queuedPaths, item.remotePath)
		m.activePath = ""
		m.activeItem = nil
		m.activeCancel = nil
		m.mu.Unlock()
		itemCancel()

		if err != nil {
			_ = os.Remove(item.localPath + ".part")
		}

		if ctx.Err() != nil {
			return
		}
	}
}

// transferFile mirrors transferFile(): downloads item via the injected
// Source.Fetch into a `.part` sibling, pacing each chunk through the
// governor, then verifies the byte count (when known) and renames into
// place. Manual (non-cache) downloads never overwrite an existing
// destination file, mirroring the original.
func (m *Manager) transferFile(ctx context.Context, item *transferItem) error {
	if err := os.MkdirAll(filepath.Dir(item.localPath), 0o755); err != nil {
		return err
	}

	if !item.cache {
		if _, err := os.Stat(item.localPath); err == nil {
			return nil // destination already exists; idle downloads never overwrite
		}
	}

	partPath := item.localPath + ".part"
	var fetchErr error
	if source, ok := m.source.(interface {
		FetchContext(context.Context, string, string, func(int) error) error
	}); ok {
		fetchErr = source.FetchContext(ctx, item.remotePath, partPath, func(n int) error { return m.governor.WaitForAllowance(ctx, n) })
	} else {
		fetchErr = m.source.Fetch(item.remotePath, partPath, func(chunkBytes int) { _ = m.governor.WaitForAllowance(ctx, chunkBytes) })
	}
	if fetchErr != nil {
		return fetchErr
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}

	if item.size > 0 {
		info, statErr := os.Stat(partPath)
		if statErr != nil {
			return statErr
		}
		if info.Size() != item.size {
			return fmt.Errorf("incomplete idle download for %s", item.remotePath)
		}
	}

	return os.Rename(partPath, item.localPath)
}
