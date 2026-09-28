package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/hostmetrics"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/sftp"
	sshpkg "github.com/IsolatedWolfLove/ssh-studio-server/internal/ssh"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/store"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/terminal"
	"github.com/IsolatedWolfLove/ssh-studio-server/internal/testssh"
)

func testApp(t *testing.T, withSFTP bool) (*App, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("integration peer executes POSIX shell commands")
	}
	host, port := testssh.Start(t, withSFTP)
	st, e := store.NewStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	a := &App{manager: sshpkg.NewManager(), store: st, services: map[string]*connectionServices{}, cancelFuncs: map[string]context.CancelFunc{}}
	a.terminals = terminal.NewRegistry(nil)
	result, e := a.Connect(ConnectInput{Host: host, Port: port, Username: "tester", Password: "test"})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.Disconnect(result.ConnectionID) })
	return a, result.ConnectionID
}
func TestApplicationFilesystem(t *testing.T) {
	for _, transport := range []string{"sftp", "shell"} {
		t.Run(transport, func(t *testing.T) {
			if transport == "shell" && runtime.GOOS == "windows" {
				t.Skip("POSIX shell fallback")
			}
			a, id := testApp(t, transport == "sftp")
			remote := t.TempDir()
			local := t.TempDir()
			name := "space ' quote.txt"
			source := filepath.Join(local, name)
			target := filepath.Join(remote, name)
			data := bytes.Repeat([]byte("hello world\n"), 60000)
			if e := os.WriteFile(source, data, 0o600); e != nil {
				t.Fatal(e)
			}
			// A partial upload must resume and publish a complete final file.
			if e := os.WriteFile(target+sftp.PartSuffix, data[:12345], 0o600); e != nil {
				t.Fatal(e)
			}
			r, e := a.UploadLocalEntries(id, UploadLocalEntriesInput{OperationID: "upload", RemotePath: remote, LocalPaths: []string{source}})
			if e != nil || r.Status != "completed" {
				t.Fatalf("upload: %+v %v", r, e)
			}
			actual, e := os.ReadFile(target)
			if e != nil || !bytes.Equal(actual, data) {
				t.Fatal("upload bytes mismatch", e)
			}
			r, e = a.UploadLocalEntries(id, UploadLocalEntriesInput{RemotePath: remote, LocalPaths: []string{source}})
			if e != nil || r.Status != "conflict" || len(r.Conflicts) != 1 {
				t.Fatalf("conflict: %+v %v", r, e)
			}
			if e = os.WriteFile(source, []byte("replacement"), 0o600); e != nil {
				t.Fatal(e)
			}
			r, e = a.UploadLocalEntries(id, UploadLocalEntriesInput{RemotePath: remote, LocalPaths: []string{source}, ConflictStrategy: "skip"})
			if e != nil || r.SkippedItems != 1 {
				t.Fatalf("skip: %+v %v", r, e)
			}
			actual, _ = os.ReadFile(target)
			if !bytes.Equal(actual, data) {
				t.Fatal("skip overwrote file")
			}
			output := filepath.Join(t.TempDir(), name)
			os.WriteFile(output+sftp.PartSuffix, data[:54321], 0o600)
			r, e = a.DownloadEntry(id, DownloadRemoteEntryInput{RemotePath: target, LocalPath: output})
			if e != nil || r.Status != "completed" {
				t.Fatalf("download: %+v %v", r, e)
			}
			actual, e = os.ReadFile(output)
			if e != nil || !bytes.Equal(actual, data) {
				t.Fatal("download bytes mismatch", e)
			}
			payload, e := a.ReadBinaryFile(id, BinaryInput{Path: target, MaxBytes: int64(len(data))})
			if e != nil {
				t.Fatal(e)
			}
			decoded, _ := base64.StdEncoding.DecodeString(payload.Base64)
			if !bytes.Equal(decoded, data) {
				t.Fatal("binary preview differs")
			}
			if _, e = a.ReadBinaryFile(id, BinaryInput{Path: target, MaxBytes: 1}); e == nil {
				t.Fatal("preview limit ignored")
			}
			if _, e = a.WriteFileAtomic(id, SaveRemoteFileInput{Path: target, Content: "needle text"}); e != nil {
				t.Fatal(e)
			}
			matches, e := a.SearchInFiles(id, sftp.SearchInput{RootPath: remote, Query: "needle", CaseSensitive: true})
			if e != nil || len(matches.Matches) != 1 {
				t.Fatalf("search: %+v %v", matches, e)
			}
			entries, e := a.ReadDir(id, remote)
			if e != nil || len(entries) != 1 {
				t.Fatalf("directory: %+v %v", entries, e)
			}
			idleTarget := filepath.Join(t.TempDir(), "idle.txt")
			if _, e = a.QueueIdleDownload(id, QueueDownloadInput{RemotePath: target, LocalPath: idleTarget}); e != nil {
				t.Fatal(e)
			}
			deadline := time.Now().Add(5 * time.Second)
			for {
				b, e := os.ReadFile(idleTarget)
				if e == nil && string(b) == "needle text" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("idle download did not finish", e)
				}
				time.Sleep(10 * time.Millisecond)
			}
			if e = a.DeleteEntry(id, DeleteRemoteEntryInput{Path: target}); e != nil {
				t.Fatal(e)
			}
			if _, e = os.Stat(target); !os.IsNotExist(e) {
				t.Fatal("delete failed")
			}
		})
	}
}

func TestTunnelsAndTerminal(t *testing.T) {
	a, id := testApp(t, true)
	saved, e := a.ListSavedConnections()
	if e != nil || len(saved) != 1 {
		t.Fatal("saved connection missing", e)
	}
	echo, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer echo.Close()
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	_, targetPort, _ := net.SplitHostPort(echo.Addr().String())
	target, _ := strconv.Atoi(targetPort)
	for _, kind := range []store.TunnelKind{store.TunnelKindLocal, store.TunnelKindRemote, store.TunnelKindDynamic} {
		t.Run(string(kind), func(t *testing.T) {
			reservation, e := net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				t.Fatal(e)
			}
			address := reservation.Addr().String()
			_, raw, _ := net.SplitHostPort(address)
			port, _ := strconv.Atoi(raw)
			reservation.Close()
			config := store.SavedTunnelConfig{ID: string(kind), Name: string(kind), Kind: kind, LocalHost: "127.0.0.1", LocalPort: port, RemoteHost: "127.0.0.1", RemotePort: port, TargetHost: "127.0.0.1", TargetPort: target}
			if e = a.SaveTunnel(saved[0].ID, config); e != nil {
				t.Fatal(e)
			}
			if e = a.StartTunnel(id, saved[0].ID, config.ID); e != nil {
				t.Fatal(e)
			}
			defer a.StopTunnel(id, config.ID)
			c, e := net.DialTimeout("tcp", address, time.Second)
			if e != nil {
				t.Fatal(e)
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(3 * time.Second))
			if kind == store.TunnelKindDynamic {
				c.Write([]byte{5, 1, 0})
				b := make([]byte, 2)
				if _, e = io.ReadFull(c, b); e != nil || !bytes.Equal(b, []byte{5, 0}) {
					t.Fatal("SOCKS negotiation", b, e)
				}
				c.Write([]byte{5, 1, 0, 1, 127, 0, 0, 1, byte(target >> 8), byte(target)})
				b = make([]byte, 10)
				if _, e = io.ReadFull(c, b); e != nil || b[1] != 0 {
					t.Fatal("SOCKS CONNECT", b, e)
				}
			}
			c.Write([]byte("tunnel works"))
			b := make([]byte, 12)
			if _, e = io.ReadFull(c, b); e != nil || string(b) != "tunnel works" {
				t.Fatal("tunnel round trip", string(b), e)
			}
			if e = a.StopTunnel(id, config.ID); e != nil {
				t.Fatal(e)
			}
			if c, e := net.DialTimeout("tcp", address, 100*time.Millisecond); e == nil {
				c.Close()
				t.Fatal("stopped tunnel still listening")
			}
		})
	}
	events := make(chan terminal.Event, 32)
	a.terminals = terminal.NewRegistry(func(v terminal.Event) { events <- v })
	term, e := a.CreateTerminal(id, CreateTerminalInput{})
	if e != nil {
		t.Fatal(e)
	}
	if e = a.ResizeTerminal(term.TerminalID, 80, 24); e != nil {
		t.Fatal(e)
	}
	if e = a.WriteTerminal(term.TerminalID, "terminal 中文\n"); e != nil {
		t.Fatal(e)
	}
	text := ""
	deadline := time.After(3 * time.Second)
	for !strings.Contains(text, "terminal 中文") {
		select {
		case event := <-events:
			text += event.Data
		case <-deadline:
			t.Fatal("terminal output timeout", text)
		}
	}
	if e = a.Disconnect(id); e != nil {
		t.Fatal(e)
	}
	if e = a.WriteTerminal(term.TerminalID, "after close"); e == nil {
		t.Fatal("terminal remains open after disconnect")
	}
}

func TestCanceledUploadPreservesDestinationAndResumes(t *testing.T) {
	a, id := testApp(t, true)
	client, e := a.sftpClient(id)
	if e != nil {
		t.Fatal(e)
	}
	remote := filepath.Join(t.TempDir(), "target")
	local := filepath.Join(t.TempDir(), "source")
	data := bytes.Repeat([]byte("resume"), 200000)
	os.WriteFile(local, data, 0o600)
	os.WriteFile(remote, []byte("original"), 0o600)
	ctx, cancel := context.WithCancel(context.Background())
	e = sftp.UploadFile(client, local, remote, sftp.TransferOptions{Ctx: ctx, OnProgress: func(string, int64) { cancel() }})
	if !sftp.IsCanceled(e) {
		t.Fatalf("expected canceled transfer, got %v", e)
	}
	original, _ := os.ReadFile(remote)
	if string(original) != "original" {
		t.Fatal("canceled transfer modified destination")
	}
	part, e := os.Stat(remote + sftp.PartSuffix)
	if e != nil || part.Size() == 0 || part.Size() >= int64(len(data)) {
		t.Fatal("partial transfer missing", e)
	}
	if e = sftp.UploadFile(client, local, remote, sftp.TransferOptions{Ctx: context.Background()}); e != nil {
		t.Fatal(e)
	}
	actual, _ := os.ReadFile(remote)
	if !bytes.Equal(actual, data) {
		t.Fatal("resumed upload differs")
	}
}
func TestDeleteSymlinkDoesNotDeleteTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires privileges on Windows")
	}
	for _, withSFTP := range []bool{true, false} {
		a, id := testApp(t, withSFTP)
		target := t.TempDir()
		file := filepath.Join(target, "keep")
		os.WriteFile(file, []byte("keep"), 0o600)
		link := filepath.Join(t.TempDir(), "link")
		if e := os.Symlink(target, link); e != nil {
			t.Fatal(e)
		}
		if e := a.DeleteEntry(id, DeleteRemoteEntryInput{Path: link}); e != nil {
			t.Fatal(e)
		}
		if b, e := os.ReadFile(file); e != nil || string(b) != "keep" {
			t.Fatal("symlink deletion modified target", e)
		}
	}
}

func TestMetricsJSONMatchesRenderer(t *testing.T) {
	snapshot := hostmetrics.ParseMetricsOutput("", 123)
	wire, e := json.Marshal(snapshot)
	if e != nil {
		t.Fatal(e)
	}
	var value map[string]any
	if e = json.Unmarshal(wire, &value); e != nil {
		t.Fatal(e)
	}
	if value["collectedAt"] != float64(123) {
		t.Fatalf("wrong wire names: %s", wire)
	}
	if _, ok := value["gpus"].([]any); !ok {
		t.Fatalf("gpus must be an array: %s", wire)
	}
	if _, ok := value["loadAverage"]; ok {
		t.Fatalf("absent metrics must be omitted: %s", wire)
	}
}
