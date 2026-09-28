package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sync"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/hostmetrics"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/idletransfer"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/lsp"
	fs "github.com/IsolatedWolfLove/ssh-studio-server/internal/sftp"
	sshpkg "github.com/IsolatedWolfLove/ssh-studio-server/internal/ssh"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/terminal"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type connectionServices struct {
	mu       sync.Mutex
	idle     *idletransfer.Manager
	metrics  *hostmetrics.Poller
	language *lsp.Manager
	display  string
	videos   map[string]*videoStream
	tunnels  map[string]*tunnelRuntime
}

func (a *App) emit(name string, value any) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, name, value)
	}
}
func (a *App) startServices(id string) {
	s, _ := a.manager.Get(id)
	services := &connectionServices{language: lsp.NewManager(), videos: make(map[string]*videoStream), tunnels: make(map[string]*tunnelRuntime)}
	services.idle = idletransfer.NewManager(&idleSource{session: s}, idletransfer.DefaultCacheLimitBytes)
	if err := services.idle.StartSession(); err != nil {
		a.emit("idleTransfer:error", err.Error())
	}
	services.metrics = hostmetrics.NewPoller(func(command string) (string, int, error) {
		r, e := s.ExecRemoteCommand(command)
		return r.Stdout, r.ExitCode, e
	}, func(snapshot hostmetrics.Snapshot) {
		a.emit("hostMetrics:event", map[string]any{"connectionId": id, "snapshot": snapshot})
	}, func(err error) { a.emit("hostMetrics:event", map[string]any{"connectionId": id, "error": err.Error()}) })
	a.servicesMu.Lock()
	a.services[id] = services
	a.servicesMu.Unlock()
	go func() {
		err := s.Client().Wait()
		a.servicesMu.Lock()
		active := a.services[id] != nil
		a.servicesMu.Unlock()
		if !active {
			return
		}
		a.stopServices(id)
		a.terminals.CloseClient(s.Client())
		_ = a.manager.Disconnect(id)
		message := "Connection closed by remote host"
		if err != nil {
			message = err.Error()
		}
		a.emitConnectionState(ConnectionStatePayload{State: "disconnected", ConnectionID: id, Message: message, Reason: "remote", Recoverable: true, FilesystemState: "idle"})
	}()
}
func (a *App) getServices(id string) (*connectionServices, error) {
	a.servicesMu.Lock()
	defer a.servicesMu.Unlock()
	s := a.services[id]
	if s == nil {
		return nil, fmt.Errorf("no active SSH connection")
	}
	return s, nil
}
func (a *App) stopServices(id string) {
	a.servicesMu.Lock()
	s := a.services[id]
	delete(a.services, id)
	a.servicesMu.Unlock()
	if s == nil {
		return
	}
	s.metrics.Stop()
	if session, e := a.manager.Get(id); e == nil {
		_ = session.Client().Close()
	}
	s.idle.StopSession()
	s.language.StopAll()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range s.videos {
		_ = v.session.Close()
	}
	for _, t := range s.tunnels {
		t.close()
	}
}
func (a *App) Shutdown(context.Context) {
	a.servicesMu.Lock()
	ids := make([]string, 0, len(a.services))
	for id := range a.services {
		ids = append(ids, id)
	}
	a.servicesMu.Unlock()
	for _, id := range ids {
		_ = a.Disconnect(id)
	}
}
func (a *App) terminalEnv(id string) map[string]string {
	s, e := a.getServices(id)
	if e != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.display == "" {
		return nil
	}
	return map[string]string{"DISPLAY": s.display}
}
func (a *App) GetRemoteShellSupport(id string) (terminal.RemoteShellSupport, error) {
	s, e := a.manager.Get(id)
	if e != nil {
		return terminal.RemoteShellSupport{}, e
	}
	return a.terminals.GetRemoteShellSupport(s.Client())
}
func (a *App) KillRemoteShellSession(id, name string) error {
	s, e := a.manager.Get(id)
	if e != nil {
		return e
	}
	return a.terminals.KillRemoteShellSession(s.Client(), name)
}
func (a *App) StartHostMetrics(id, workspace string, interval int) error {
	s, e := a.getServices(id)
	if e != nil {
		return e
	}
	s.metrics.Start(workspace, interval)
	return nil
}
func (a *App) StopHostMetrics(id string) error {
	s, e := a.getServices(id)
	if e != nil {
		return nil
	}
	s.metrics.Stop()
	return nil
}
func (a *App) RefreshHostMetrics(id, workspace string) (hostmetrics.Snapshot, error) {
	s, e := a.manager.Get(id)
	if e != nil {
		return hostmetrics.Snapshot{}, e
	}
	return hostmetrics.Collect(func(c string) (string, int, error) { r, e := s.ExecRemoteCommand(c); return r.Stdout, r.ExitCode, e }, workspace)
}
func remoteExec(s *sshpkg.Session) fs.ExecFunc {
	return func(c string) (string, string, int, error) {
		r, e := s.ExecRemoteCommand(c)
		return r.Stdout, r.Stderr, r.ExitCode, e
	}
}
func (a *App) SearchInFiles(id string, input fs.SearchInput) (fs.SearchResult, error) {
	s, e := a.manager.Get(id)
	if e != nil {
		return fs.SearchResult{}, e
	}
	return fs.SearchInFiles(s.SFTP(), remoteExec(s), input)
}
func (a *App) GetTransferCapabilities(id string) (map[string]bool, error) {
	s, e := a.manager.Get(id)
	if e != nil {
		return nil, e
	}
	_, local := exec.LookPath("rsync")
	r, e := s.ExecRemoteCommand("command -v rsync >/dev/null 2>&1")
	return map[string]bool{"localRsync": local == nil, "remoteRsync": e == nil && r.ExitCode == 0}, nil
}

type BinaryInput struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes"`
}
type BinaryPayload struct {
	Path       string `json:"path"`
	Base64     string `json:"base64"`
	ByteLength int    `json:"byteLength"`
	ModifiedAt int64  `json:"modifiedAt"`
}

func (a *App) ReadBinaryFile(id string, input BinaryInput) (BinaryPayload, error) {
	client, e := a.sftpClient(id)
	if e != nil {
		return BinaryPayload{}, e
	}
	info, e := client.Stat(input.Path)
	if e != nil {
		return BinaryPayload{}, e
	}
	limit := input.MaxBytes
	if limit <= 0 {
		limit = 64 * 1024 * 1024
	}
	if info.Size() > limit {
		return BinaryPayload{}, fmt.Errorf("file exceeds preview limit (%d bytes)", limit)
	}
	modified := info.ModTime().UnixMilli()
	services, e := a.getServices(id)
	if e != nil {
		return BinaryPayload{}, e
	}
	data, hit := services.idle.ReadCached(input.Path, info.Size(), &modified)
	if !hit {
		done := services.idle.Governor().BeginForeground()
		defer done()
		f, e := client.Open(input.Path)
		if e != nil {
			return BinaryPayload{}, e
		}
		defer f.Close()
		data, e = io.ReadAll(io.LimitReader(f, limit+1))
		if e != nil {
			return BinaryPayload{}, e
		}
		if int64(len(data)) > limit {
			return BinaryPayload{}, fmt.Errorf("file exceeds preview limit")
		}
	}
	return BinaryPayload{input.Path, base64.StdEncoding.EncodeToString(data), len(data), modified}, nil
}
func (a *App) GetIdleTransferSnapshot(id string) (idletransfer.Snapshot, error) {
	s, e := a.getServices(id)
	if e != nil {
		return idletransfer.Snapshot{}, e
	}
	return s.idle.Snapshot(), nil
}
func (a *App) StartAutomaticMediaCache(id, directory string) (idletransfer.Snapshot, error) {
	s, e := a.getServices(id)
	if e != nil {
		return idletransfer.Snapshot{}, e
	}
	s.idle.StartAutomaticMediaCache(directory)
	return s.idle.Snapshot(), nil
}

type QueueDownloadInput struct {
	RemotePath string `json:"remotePath"`
	LocalPath  string `json:"localPath"`
}

func (a *App) QueueIdleDownload(id string, input QueueDownloadInput) (*idletransfer.Snapshot, error) {
	s, e := a.getServices(id)
	if e != nil {
		return nil, e
	}
	if input.LocalPath == "" {
		dir, e := a.PickDownloadDirectory()
		if e != nil || dir == "" {
			return nil, e
		}
		input.LocalPath = filepath.Join(dir, path.Base(input.RemotePath))
	}
	snapshot, e := s.idle.QueueIdleDownload(input.RemotePath, input.LocalPath)
	return &snapshot, e
}
func (a *App) CancelIdleDownload(id, p string) (idletransfer.Snapshot, error) {
	s, e := a.getServices(id)
	if e != nil {
		return idletransfer.Snapshot{}, e
	}
	return s.idle.CancelDownload(p), nil
}
func (a *App) CancelIdleDownloadGroup(id, p string) (idletransfer.Snapshot, error) {
	s, e := a.getServices(id)
	if e != nil {
		return idletransfer.Snapshot{}, e
	}
	return s.idle.CancelGroup(p), nil
}

type idleSource struct{ session *sshpkg.Session }

func (s *idleSource) Stat(p string) (idletransfer.Stat, error) {
	c := s.session.SFTP()
	if c == nil {
		return idletransfer.Stat{}, fmt.Errorf("SFTP unavailable")
	}
	i, e := c.Stat(p)
	if e != nil {
		return idletransfer.Stat{}, e
	}
	m := i.ModTime().UnixMilli()
	return idletransfer.Stat{IsDir: i.IsDir(), Size: i.Size(), ModifiedAt: &m}, nil
}
func (s *idleSource) ReadDir(p string) ([]idletransfer.RemoteEntry, error) {
	c := s.session.SFTP()
	if c == nil {
		return nil, fmt.Errorf("SFTP unavailable")
	}
	entries, e := fs.ReadDir(c, p)
	if e != nil {
		return nil, e
	}
	out := make([]idletransfer.RemoteEntry, 0, len(entries))
	for _, v := range entries {
		m := v.ModifiedAt
		out = append(out, idletransfer.RemoteEntry{Name: v.Name, Path: v.Path, IsDir: v.Kind == fs.EntryKind("directory"), Size: v.Size, ModifiedAt: &m})
	}
	return out, nil
}
func (s *idleSource) Fetch(remote, local string, progress func(int)) error {
	return s.FetchContext(context.Background(), remote, local, func(n int) error { progress(n); return nil })
}
func (s *idleSource) FetchContext(ctx context.Context, remote, local string, progress func(int) error) error {
	c := s.session.SFTP()
	if c == nil {
		return fmt.Errorf("filesystem unavailable")
	}
	f, e := c.Open(remote)
	if e != nil {
		return e
	}
	defer f.Close()
	out, e := os.Create(local)
	if e != nil {
		return e
	}
	defer out.Close()
	buf := make([]byte, 32768)
	for {
		if e := ctx.Err(); e != nil {
			return e
		}
		n, e := f.Read(buf)
		if n > 0 {
			if err := progress(n); err != nil {
				return err
			}
			if _, err := out.Write(buf[:n]); err != nil {
				return err
			}
		}
		if e == io.EOF {
			return out.Close()
		}
		if e != nil {
			return e
		}
	}
}
