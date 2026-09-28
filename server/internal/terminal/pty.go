// Package terminal implements interactive-shell (PTY) sessions over SSH,
// replacing createTerminal/writeTerminal/resizeTerminal/closeTerminal (plus
// the persistent tmux/screen attach path) in src/main/ssh-session.ts for the
// Wails backend.
//
// The PTY itself lives on the remote host; this package only relays bytes
// over the SSH session's stdin/stdout, so there is no local
// pseudo-terminal (no ConPTY-on-Windows concern) — see the plan's Phase 1.3
// note.
package terminal

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

// Event mirrors contracts.ts's TerminalEvent union.
type Event struct {
	Type       string // "data" | "exit" | "error"
	TerminalID string
	Data       string
	Message    string
}

// CreateTerminalInput mirrors contracts.ts's CreateTerminalInput.
type CreateTerminalInput struct {
	// SessionName requests a persistent tmux/screen session with this name,
	// attaching to it if it already exists. Empty means a plain, non-
	// persistent shell, matching ssh-session.ts's requestedSessionName === ''
	// check.
	SessionName   string
	WorkspacePath string
	// Env is passed through to the attach command (e.g. vision mode's
	// DISPLAY), matching the `env` ssh-session.ts's createTerminal passes to
	// buildAttachCommand.
	Env map[string]string
}

// CreateResult mirrors contracts.ts's CreateTerminalResult. Named
// CreateResult rather than CreateTerminalResult to make clear this is this
// package's own return shape, not app/types.go's JSON-tagged twin - the
// integration pass maps between the two.
type CreateResult struct {
	TerminalID string
	// SessionName/PersistentKind are only set when the terminal is running
	// inside a persistent multiplexer session (PersistentKind != ShellKindNone).
	SessionName    string
	PersistentKind PersistentShellKind
}

// Session holds one interactive remote shell. Mirrors ssh-session.ts's
// TerminalSession (client + channel pair). sessionName/persistentKind are
// recorded for symmetry with the original's TerminalSession shape, though
// nothing in this package currently reads them back after Create returns.
type Session struct {
	mu             sync.Mutex
	id             string
	client         *ssh.Client
	session        *ssh.Session
	stdin          io.WriteCloser
	closed         bool
	sessionName    string
	persistentKind PersistentShellKind
}

// Registry tracks live terminal Sessions by ID and fans out Events to a
// single callback (wired to runtime.EventsEmit by the caller). Mirrors the
// `terminals` map + `emitTerminalEvent` in ssh-session.ts.
//
// shellKinds caches each *ssh.Client's probed PersistentShellKind (mirrors
// ssh-session.ts's per-connection `persistentShellKind` field, which
// resolvePersistentShellKind populates once and reuses). Registry itself has
// no notion of "per connection" (it is flat map[string]*Session by terminal
// ID, not connection ID), so the probe is cached by *ssh.Client pointer
// identity instead - correct as long as a *ssh.Client's identity is stable
// for its connection's lifetime, which holds per Phase 1's
// internal/ssh.Session (one client per connection, never swapped in place).
type Registry struct {
	mu         sync.Mutex
	items      map[string]*Session
	shellKinds map[*ssh.Client]PersistentShellKind
	onEvent    func(Event)
}

// NewRegistry creates a Registry that calls onEvent for every terminal
// event. onEvent must be safe to call concurrently.
func NewRegistry(onEvent func(Event)) *Registry {
	return &Registry{
		items:      make(map[string]*Session),
		shellKinds: make(map[*ssh.Client]PersistentShellKind),
		onEvent:    onEvent,
	}
}

const (
	defaultCols = 120
	defaultRows = 32
)

// Create opens a new interactive shell (PTY) on client and registers it
// under terminalID (chosen by the caller so app.go can also use it as the
// Wails-side identifier). Mirrors createTerminalChannel + createTerminal in
// ssh-session.ts, including the persistent-multiplexer attach branch: when
// input.SessionName is set and the remote host has tmux or screen, the PTY's
// initial command is the attach/create command (BuildAttachCommand) instead
// of an interactive login shell - mirroring ssh-session.ts's
// `client.exec(command, {pty: window}, handle)` (session.Start(cmd) after
// RequestPty, the x/crypto/ssh equivalent of ssh2's exec-with-pty) rather
// than `client.shell(window, handle)` (session.Shell()).
//
// A probe failure (or SessionName == "") falls back to a plain shell rather
// than erroring out, mirroring ssh-session.ts's
// `.catch(() => 'none' as PersistentShellKind)`.
func (r *Registry) Create(client *ssh.Client, terminalID string, input CreateTerminalInput) (CreateResult, error) {
	requestedSessionName := strings.TrimSpace(input.SessionName)

	persistentKind := ShellKindNone
	if requestedSessionName != "" {
		if kind, err := r.resolvePersistentShellKind(client); err == nil {
			persistentKind = kind
		}
	}

	sshSession, err := client.NewSession()
	if err != nil {
		return CreateResult{}, err
	}

	if err := sshSession.RequestPty("xterm-256color", defaultRows, defaultCols, ssh.TerminalModes{}); err != nil {
		sshSession.Close()
		return CreateResult{}, err
	}

	stdin, err := sshSession.StdinPipe()
	if err != nil {
		sshSession.Close()
		return CreateResult{}, err
	}
	stdout, err := sshSession.StdoutPipe()
	if err != nil {
		sshSession.Close()
		return CreateResult{}, err
	}
	stderr, err := sshSession.StderrPipe()
	if err != nil {
		sshSession.Close()
		return CreateResult{}, err
	}

	if persistentKind == ShellKindNone {
		if err := sshSession.Shell(); err != nil {
			sshSession.Close()
			return CreateResult{}, err
		}
		if display := input.Env["DISPLAY"]; display != "" {
			if _, err := io.WriteString(stdin, "export DISPLAY="+QuoteForShell(display)+"\r"); err != nil {
				sshSession.Close()
				return CreateResult{}, err
			}
		}

	} else {
		attachCommand, err := BuildAttachCommand(PersistentShellCommandInput{
			Kind:          persistentKind,
			SessionName:   requestedSessionName,
			WorkspacePath: input.WorkspacePath,
			Env:           input.Env,
		})
		if err != nil {
			sshSession.Close()
			return CreateResult{}, err
		}
		if err := sshSession.Start(attachCommand); err != nil {
			sshSession.Close()
			return CreateResult{}, err
		}
	}

	normalizedSessionName := ""
	if persistentKind != ShellKindNone {
		normalizedSessionName = NormalizeSessionName(requestedSessionName)
	}

	session := &Session{
		id:             terminalID,
		client:         client,
		session:        sshSession,
		stdin:          stdin,
		sessionName:    normalizedSessionName,
		persistentKind: persistentKind,
	}

	r.mu.Lock()
	r.items[terminalID] = session
	r.mu.Unlock()

	go r.pump(session, stdout)
	go r.pump(session, stderr)
	go r.waitExit(session)

	result := CreateResult{TerminalID: terminalID}
	if persistentKind != ShellKindNone {
		result.SessionName = normalizedSessionName
		result.PersistentKind = persistentKind
	}

	return result, nil
}

func (r *Registry) pump(session *Session, reader io.Reader) {
	buf := make([]byte, 32*1024)
	pending := []byte{}
	for {
		n, err := reader.Read(buf)
		pending = append(pending, buf[:n]...)
		end := 0
		for end < len(pending) {
			if !utf8.FullRune(pending[end:]) && err == nil {
				break
			}
			_, size := utf8.DecodeRune(pending[end:])
			end += size
		}
		if end > 0 {
			r.emit(Event{Type: "data", TerminalID: session.id, Data: string(pending[:end])})
			pending = append(pending[:0], pending[end:]...)
		}
		if err != nil {
			return
		}
	}
}

func (r *Registry) waitExit(session *Session) {
	_ = session.session.Wait()
	r.mu.Lock()
	_, stillPresent := r.items[session.id]
	if stillPresent {
		delete(r.items, session.id)
	}
	r.mu.Unlock()

	if stillPresent {
		r.emit(Event{Type: "exit", TerminalID: session.id})
	}
}

func (r *Registry) emit(event Event) {
	if r.onEvent != nil {
		r.onEvent(event)
	}
}

// Write sends data to terminalID's stdin. Mirrors writeTerminal.
func (r *Registry) Write(terminalID, data string) error {
	session, err := r.get(terminalID)
	if err != nil {
		return err
	}
	_, err = session.stdin.Write([]byte(data))
	return err
}

// Resize changes terminalID's PTY window size. Mirrors resizeTerminal
// (terminal.setWindow(rows, cols, 0, 0) in ssh2 -> Session.WindowChange in
// x/crypto/ssh, which exists in the pinned version — see the plan's Phase
// 1.3 risk note; confirmed present, no RFC 4254 §6.7 fallback needed).
func (r *Registry) Resize(terminalID string, cols, rows int) error {
	session, err := r.get(terminalID)
	if err != nil {
		return err
	}
	return session.session.WindowChange(rows, cols)
}

// Close terminates terminalID's shell session. Mirrors closeTerminal.
func (r *Registry) Close(terminalID string) error {
	r.mu.Lock()
	session, ok := r.items[terminalID]
	if ok {
		delete(r.items, terminalID)
	}
	r.mu.Unlock()

	if !ok {
		return nil
	}

	session.mu.Lock()
	session.closed = true
	session.mu.Unlock()

	return session.session.Close()
}

// CloseAll terminates every live terminal, e.g. on disconnect. Mirrors the
// terminal-teardown loop in SshSessionManager.disconnect.
func (r *Registry) CloseAll() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.items))
	for id := range r.items {
		ids = append(ids, id)
	}
	r.mu.Unlock()

	for _, id := range ids {
		_ = r.Close(id)
	}
}

func (r *Registry) get(terminalID string) (*Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.items[terminalID]
	if !ok {
		return nil, errors.New("no active terminal session")
	}
	return session, nil
}

// --- persistent multiplexer support ----------------------------------------

// GetRemoteShellSupport mirrors getRemoteShellSupport: probes (or reuses the
// cached probe for) client's persistent-shell kind, then lists its sessions.
func (r *Registry) GetRemoteShellSupport(client *ssh.Client) (RemoteShellSupport, error) {
	kind, err := r.resolvePersistentShellKind(client)
	if err != nil {
		return RemoteShellSupport{}, err
	}

	listCommand := BuildListSessionsCommand(kind)
	if listCommand == nil {
		return RemoteShellSupport{Kind: kind, Sessions: []RemoteShellSessionSummary{}}, nil
	}

	stdout, _, _, err := r.execCommand(client, *listCommand)
	if err != nil {
		return RemoteShellSupport{}, err
	}

	return RemoteShellSupport{Kind: kind, Sessions: ParseSessionList(kind, stdout)}, nil
}

// KillRemoteShellSession mirrors killRemoteShellSession.
func (r *Registry) KillRemoteShellSession(client *ssh.Client, sessionName string) error {
	kind, err := r.resolvePersistentShellKind(client)
	if err != nil {
		return err
	}
	if kind == ShellKindNone {
		return ErrNoMultiplexer
	}

	command, err := BuildKillSessionCommand(kind, sessionName)
	if err != nil {
		return err
	}

	_, stderr, exitCode, err := r.execCommand(client, command)
	if err != nil {
		return err
	}
	if exitCode != 0 {
		trimmed := strings.TrimSpace(stderr)
		if trimmed == "" {
			trimmed = fmt.Sprintf("unable to end session %s", sessionName)
		}
		return errors.New(trimmed)
	}
	return nil
}

// resolvePersistentShellKind mirrors resolvePersistentShellKind: probes
// client once (caching the result by *ssh.Client pointer identity, see the
// Registry doc comment) and reuses the cached kind on subsequent calls.
func (r *Registry) resolvePersistentShellKind(client *ssh.Client) (PersistentShellKind, error) {
	r.mu.Lock()
	if kind, ok := r.shellKinds[client]; ok {
		r.mu.Unlock()
		return kind, nil
	}
	r.mu.Unlock()

	stdout, _, _, err := r.execCommand(client, BuildSupportProbeCommand())
	if err != nil {
		return ShellKindNone, err
	}
	kind := ParseSupportProbe(stdout)

	r.mu.Lock()
	r.shellKinds[client] = kind
	r.mu.Unlock()

	return kind, nil
}

// execCommand runs command over a fresh exec channel on client and collects
// its stdout/stderr/exit code. A local, package-scoped duplicate of
// internal/ssh.Session.ExecRemoteCommand's ~15-line pattern rather than an
// import of that package, to avoid a cross-package dependency for one helper
// (internal/ssh may be edited concurrently by another workstream; this
// package only needs a *ssh.Client, which app.go already has available via
// internal/ssh.Session.Client()).
func (r *Registry) execCommand(client *ssh.Client, command string) (stdout, stderr string, exitCode int, err error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", "", 0, err
	}
	defer sess.Close()

	var outBuf, errBuf strings.Builder
	sess.Stdout = &outBuf
	sess.Stderr = &errBuf

	if runErr := sess.Run(command); runErr != nil {
		if exitErr, ok := runErr.(*ssh.ExitError); ok {
			return outBuf.String(), errBuf.String(), exitErr.ExitStatus(), nil
		}
		if _, ok := runErr.(*ssh.ExitMissingError); ok {
			return outBuf.String(), errBuf.String(), -1, nil
		}
		return "", "", 0, runErr
	}

	return outBuf.String(), errBuf.String(), 0, nil
}

// SetDisplay updates existing shells; newly created shells receive Env.
func (r *Registry) SetDisplay(display string) {
	r.mu.Lock()
	ids := make([]string, 0, len(r.items))
	for id := range r.items {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	command := "unset DISPLAY\r"
	if display != "" {
		command = "export DISPLAY=" + QuoteForShell(display) + "\r"
	}
	for _, id := range ids {
		_ = r.Write(id, command)
	}
}

func (r *Registry) CloseClient(client *ssh.Client) {
	r.mu.Lock()
	ids := []string{}
	for id, s := range r.items {
		if s.client == client {
			ids = append(ids, id)
		}
	}
	delete(r.shellKinds, client)
	r.mu.Unlock()
	for _, id := range ids {
		_ = r.Close(id)
	}
}
