package lsp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

// shutdownTimeout mirrors SHUTDOWN_TIMEOUT_MS in language-server-manager.ts:
// how long StopSession waits for a "shutdown" response before giving up and
// sending "exit"/closing the transport anyway.
const shutdownTimeout = 1500 * time.Millisecond

// unavailablePattern mirrors the exact regex language-server-manager.ts uses
// in start()'s catch block to classify a startup failure as "the language
// server isn't installed" (status: 'unavailable') rather than a generic
// error: /not installed|not found|exit(?:ed)? with code 127/i.
var unavailablePattern = regexp.MustCompile(`(?i)not installed|not found|exit(?:ed)? with code 127`)

// IsUnavailableMessage reports whether message matches the same heuristic
// language-server-manager.ts uses to classify a startup failure as
// 'unavailable' vs 'error'.
//
// StartSession applies this automatically to the error from the
// initialize/initialized handshake. It is exported because that handshake
// error (a JSON-RPC/transport failure) will rarely contain the installer
// hint text - that text is written to the remote process's stderr, which
// this package's StartSession(rw io.ReadWriteCloser, ...) signature has no
// access to (an SSH exec channel's stderr is a separate stream from its
// stdin/stdout). A caller with access to that stderr stream (the
// integration layer, via internal/ssh) can call IsUnavailableMessage on the
// captured stderr text directly for a more accurate classification than
// StartSession alone can produce - see the report for this known gap.
func IsUnavailableMessage(message string) bool {
	return unavailablePattern.MatchString(message)
}

// Position mirrors contracts.ts's LanguageServerPosition.
type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

// Range mirrors contracts.ts's LanguageServerRange.
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

// Diagnostic mirrors contracts.ts's LanguageServerDiagnostic. Code is kept
// as raw JSON since the original allows string | number there.
type Diagnostic struct {
	Range    Range           `json:"range"`
	Severity *int            `json:"severity,omitempty"`
	Code     json.RawMessage `json:"code,omitempty"`
	Source   *string         `json:"source,omitempty"`
	Message  string          `json:"message"`
}

// DiagnosticsEvent mirrors contracts.ts's LanguageServerDiagnosticsEvent.
type DiagnosticsEvent struct {
	SessionID   string       `json:"sessionId"`
	RemotePath  string       `json:"remotePath"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// StateEvent mirrors contracts.ts's LanguageServerStateEvent.
type StateEvent struct {
	SessionID     string `json:"sessionId,omitempty"`
	WorkspacePath string `json:"workspacePath"`
	Language      string `json:"language"`
	Status        string `json:"status"`
	Message       string `json:"message"`
}

// ContentChange mirrors one entry of contracts.ts's
// LanguageServerDocumentChangeInput.contentChanges.
type ContentChange struct {
	Range       *Range `json:"range,omitempty"`
	RangeLength *int   `json:"rangeLength,omitempty"`
	Text        string `json:"text"`
}

type sessionState struct {
	mu            sync.Mutex
	id            string
	workspacePath string
	language      string
	client        *Client
	openDocuments map[string]bool
	closing       bool
	onDiagnostics func(DiagnosticsEvent)
	onState       func(StateEvent)
}

func (s *sessionState) emitState(status, message string) {
	if s.onState != nil {
		s.onState(StateEvent{
			SessionID:     s.id,
			WorkspacePath: s.workspacePath,
			Language:      s.language,
			Status:        status,
			Message:       message,
		})
	}
}

// Manager tracks live remote-language-server sessions, mirroring
// RemoteLanguageServerManager. Each session wraps a *Client speaking
// JSON-RPC over an io.ReadWriteCloser supplied by the caller.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*sessionState
	nextID   int64
}

// NewManager creates an empty Manager.
func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*sessionState)}
}

// StartSession starts (or, if one is already running for the same
// workspacePath+language and not currently closing, reuses) a remote
// language server session over rw, performing the LSP initialize/initialized
// handshake mirrored from start() in language-server-manager.ts.
// onDiagnostics is invoked for every textDocument/publishDiagnostics
// notification the server sends for this session; onState is invoked for
// every lifecycle transition (starting/ready/error/unavailable/stopped),
// including the ones this call itself triggers.
func (m *Manager) StartSession(rw io.ReadWriteCloser, workspacePath string, language string, onDiagnostics func(DiagnosticsEvent), onState func(StateEvent)) (string, error) {
	normalizedWorkspace, err := normalizeRemotePath(workspacePath)
	if err != nil {
		return "", err
	}

	if existingID, ok := m.findReusableSession(normalizedWorkspace, language); ok {
		_ = rw.Close()
		return existingID, nil
	}

	m.mu.Lock()
	m.nextID++
	sessionID := fmt.Sprintf("lsp-%d", m.nextID)
	m.mu.Unlock()

	session := &sessionState{
		id:            sessionID,
		workspacePath: normalizedWorkspace,
		language:      language,
		openDocuments: make(map[string]bool),
		onDiagnostics: onDiagnostics,
		onState:       onState,
	}
	session.emitState("starting", "Starting remote TypeScript language server...")

	rootURI, err := RemotePathToFileURI(normalizedWorkspace)
	if err != nil {
		session.emitState("error", err.Error())
		return "", err
	}

	session.client = NewClient(rw)
	m.registerHandlers(session)

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	_, err = session.client.Request("initialize", initializeParams(rootURI, normalizedWorkspace))
	if err == nil {
		err = session.client.Notify("initialized", struct{}{})
	}
	if err != nil {
		message := err.Error()
		status := "error"
		if IsUnavailableMessage(message) {
			status = "unavailable"
		}

		session.mu.Lock()
		session.closing = true
		session.mu.Unlock()
		m.mu.Lock()
		delete(m.sessions, sessionID)
		m.mu.Unlock()
		_ = session.client.Close()

		session.emitState(status, message)
		return "", errors.New(message)
	}

	session.emitState("ready", "Remote TypeScript language server ready")
	m.observeClose(session)
	return sessionID, nil
}

func (m *Manager) findReusableSession(workspacePath, language string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.sessions {
		existing.mu.Lock()
		match := existing.workspacePath == workspacePath && existing.language == language && !existing.closing
		id := existing.id
		existing.mu.Unlock()
		if match {
			return id, true
		}
	}
	return "", false
}

func (m *Manager) registerHandlers(session *sessionState) {
	client := session.client

	client.OnNotification("textDocument/publishDiagnostics", func(params json.RawMessage) {
		var payload struct {
			URI         string       `json:"uri"`
			Diagnostics []Diagnostic `json:"diagnostics"`
		}
		if err := json.Unmarshal(params, &payload); err != nil {
			return
		}
		remotePath, ok := FileURIToRemotePath(payload.URI)
		if !ok || session.onDiagnostics == nil {
			return
		}
		session.onDiagnostics(DiagnosticsEvent{
			SessionID:   session.id,
			RemotePath:  remotePath,
			Diagnostics: payload.Diagnostics,
		})
	})

	client.OnRequest("workspace/configuration", func(params json.RawMessage) (any, error) {
		var payload struct {
			Items []json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(params, &payload)
		return make([]any, len(payload.Items)), nil
	})

	client.OnRequest("workspace/workspaceFolders", func(json.RawMessage) (any, error) {
		rootURI, err := RemotePathToFileURI(session.workspacePath)
		if err != nil {
			return nil, err
		}
		return []map[string]any{{"uri": rootURI, "name": workspaceFolderName(session.workspacePath)}}, nil
	})

	client.OnRequest("client/registerCapability", func(json.RawMessage) (any, error) { return nil, nil })
	client.OnRequest("client/unregisterCapability", func(json.RawMessage) (any, error) { return nil, nil })
	client.OnRequest("window/workDoneProgress/create", func(json.RawMessage) (any, error) { return nil, nil })
	client.OnRequest("workspace/applyEdit", func(json.RawMessage) (any, error) {
		return map[string]any{"applied": false, "failureReason": "Apply edits in SSH Studio"}, nil
	})

}

func (m *Manager) observeClose(session *sessionState) {
	session.client.OnClose(func(err error) {
		session.mu.Lock()
		if session.closing {
			session.mu.Unlock()
			return
		}
		session.closing = true
		session.mu.Unlock()

		m.mu.Lock()
		delete(m.sessions, session.id)
		m.mu.Unlock()

		message := "Remote language server stopped"
		if err != nil {
			message = err.Error()
		}
		session.emitState("error", message)
	})
}

// StopSession requests a graceful shutdown/exit from sessionId's language
// server (a "shutdown" request bounded by shutdownTimeout, then an "exit"
// notification, both best-effort - mirroring stop()/stopSession(..., true)),
// closes the underlying transport, and emits a final "stopped" state. A
// missing or already-closing sessionId is a no-op.
func (m *Manager) StopSession(sessionID string) error {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
	if !ok {
		return nil
	}

	session.mu.Lock()
	if session.closing {
		session.mu.Unlock()
		return nil
	}
	session.closing = true
	session.mu.Unlock()

	shutdownSession(session)
	session.emitState("stopped", "Remote language server stopped")
	return nil
}

// StopAll stops every live session concurrently, mirroring stopAll()'s
// stopSession(session, false) calls: unlike StopSession, no final "stopped"
// state is emitted per session (this is meant for whole-connection
// teardown, where per-session state events would be noise the UI has no
// use for once the connection itself is going away).
func (m *Manager) StopAll() {
	m.mu.Lock()
	sessions := make([]*sessionState, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.sessions = make(map[string]*sessionState)
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, session := range sessions {
		session.mu.Lock()
		alreadyClosing := session.closing
		session.closing = true
		session.mu.Unlock()
		if alreadyClosing {
			continue
		}
		wg.Add(1)
		go func(s *sessionState) {
			defer wg.Done()
			shutdownSession(s)
		}(session)
	}
	wg.Wait()
}

func shutdownSession(session *sessionState) {
	done := make(chan struct{})
	go func() {
		_, _ = session.client.Request("shutdown", nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownTimeout):
	}
	_ = session.client.Notify("exit", struct{}{})
	_ = session.client.Close()
}

func (m *Manager) session(sessionID string) (*sessionState, error) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return nil, errors.New("language server session is not active")
	}

	session.mu.Lock()
	closing := session.closing
	session.mu.Unlock()
	if closing {
		return nil, errors.New("language server session is not active")
	}
	return session, nil
}

// OpenDocument sends textDocument/didOpen, mirroring openDocument().
func (m *Manager) OpenDocument(sessionID, remotePath, languageID string, version int, text string) error {
	session, err := m.session(sessionID)
	if err != nil {
		return err
	}
	normalized, err := normalizeRemotePath(remotePath)
	if err != nil {
		return err
	}
	uri, err := RemotePathToFileURI(normalized)
	if err != nil {
		return err
	}

	session.mu.Lock()
	session.openDocuments[normalized] = true
	session.mu.Unlock()

	return session.client.Notify("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri":        uri,
			"languageId": languageID,
			"version":    version,
			"text":       text,
		},
	})
}

// ChangeDocument sends textDocument/didChange, mirroring changeDocument().
// Returns an error if remotePath was not previously opened via OpenDocument,
// matching the original's guard.
func (m *Manager) ChangeDocument(sessionID, remotePath string, version int, contentChanges []ContentChange) error {
	session, err := m.session(sessionID)
	if err != nil {
		return err
	}
	normalized, err := normalizeRemotePath(remotePath)
	if err != nil {
		return err
	}

	session.mu.Lock()
	isOpen := session.openDocuments[normalized]
	session.mu.Unlock()
	if !isOpen {
		return fmt.Errorf("language document is not open: %s", normalized)
	}

	uri, err := RemotePathToFileURI(normalized)
	if err != nil {
		return err
	}

	return session.client.Notify("textDocument/didChange", map[string]any{
		"textDocument":   map[string]any{"uri": uri, "version": version},
		"contentChanges": contentChanges,
	})
}

// SaveDocument sends textDocument/didSave, mirroring saveDocument(). A
// remotePath that was never opened (or already closed) is a silent no-op,
// matching the original.
func (m *Manager) SaveDocument(sessionID, remotePath string) error {
	session, err := m.session(sessionID)
	if err != nil {
		return err
	}
	normalized, err := normalizeRemotePath(remotePath)
	if err != nil {
		return err
	}

	session.mu.Lock()
	isOpen := session.openDocuments[normalized]
	session.mu.Unlock()
	if !isOpen {
		return nil
	}

	uri, err := RemotePathToFileURI(normalized)
	if err != nil {
		return err
	}
	return session.client.Notify("textDocument/didSave", map[string]any{
		"textDocument": map[string]any{"uri": uri},
	})
}

// CloseDocument sends textDocument/didClose, mirroring closeDocument(). A
// remotePath that was never opened is a silent no-op, matching the
// original.
func (m *Manager) CloseDocument(sessionID, remotePath string) error {
	session, err := m.session(sessionID)
	if err != nil {
		return err
	}
	normalized, err := normalizeRemotePath(remotePath)
	if err != nil {
		return err
	}

	session.mu.Lock()
	wasOpen := session.openDocuments[normalized]
	delete(session.openDocuments, normalized)
	session.mu.Unlock()
	if !wasOpen {
		return nil
	}

	uri, err := RemotePathToFileURI(normalized)
	if err != nil {
		return err
	}
	return session.client.Notify("textDocument/didClose", map[string]any{
		"textDocument": map[string]any{"uri": uri},
	})
}

var featureMethods = map[string]string{
	"completion": "textDocument/completion",
	"hover":      "textDocument/hover",
	"definition": "textDocument/definition",
}

// RequestFeature dispatches a completion/hover/definition request, mirroring
// requestFeature(). Returns the raw LSP response for the integration layer
// to map into contracts.ts-shaped results.
func (m *Manager) RequestFeature(sessionID, remotePath string, feature string, position Position) (json.RawMessage, error) {
	session, err := m.session(sessionID)
	if err != nil {
		return nil, err
	}
	method, ok := featureMethods[feature]
	if !ok {
		return nil, fmt.Errorf("unsupported language server feature: %s", feature)
	}
	normalized, err := normalizeRemotePath(remotePath)
	if err != nil {
		return nil, err
	}
	uri, err := RemotePathToFileURI(normalized)
	if err != nil {
		return nil, err
	}
	return session.client.Request(method, map[string]any{
		"textDocument": map[string]any{"uri": uri},
		"position":     position,
	})
}

func workspaceFolderName(workspacePath string) string {
	name := path.Base(workspacePath)
	if name == "" || name == "." {
		return "/"
	}
	return name
}

func initializeParams(rootURI, workspacePath string) map[string]any {
	return map[string]any{
		"processId": nil,
		"clientInfo": map[string]any{
			"name":    "SSH Studio",
			"version": "0.2.1",
		},
		"rootUri": rootURI,
		"workspaceFolders": []map[string]any{
			{"uri": rootURI, "name": workspaceFolderName(workspacePath)},
		},
		"capabilities": map[string]any{
			"workspace": map[string]any{
				"configuration":    true,
				"workspaceFolders": true,
			},
			"textDocument": map[string]any{
				"synchronization": map[string]any{"didSave": true},
				"completion": map[string]any{
					"completionItem": map[string]any{
						"snippetSupport":      true,
						"documentationFormat": []string{"markdown", "plaintext"},
					},
				},
				"hover":              map[string]any{"contentFormat": []string{"markdown", "plaintext"}},
				"definition":         map[string]any{"linkSupport": true},
				"publishDiagnostics": map[string]any{"relatedInformation": true},
			},
		},
	}
}

// quoteForShell mirrors quoteForShell in language-server-manager.ts: wraps
// value in single quotes, escaping any embedded single quote as '\”.
func quoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// StartCommand mirrors buildServerCommand: the remote shell command that
// cds into workspacePath and execs a locally-installed
// typescript-language-server if present, else a globally-installed one,
// else prints an install hint to stderr and exits 127 (the exit code
// IsUnavailableMessage's pattern recognizes).
func StartCommand(workspacePath string, language string) (string, error) {
	normalized, err := normalizeRemotePath(workspacePath)
	if err != nil {
		return "", err
	}
	if language != "typescript" {
		return "", fmt.Errorf("unsupported language server: %s", language)
	}

	root := quoteForShell(normalized)
	lines := []string{
		"cd -- " + root,
		"if [ -x ./node_modules/.bin/typescript-language-server ]; then",
		"  exec ./node_modules/.bin/typescript-language-server --stdio",
		"elif command -v typescript-language-server >/dev/null 2>&1; then",
		"  exec typescript-language-server --stdio",
		"else",
		"  echo 'typescript-language-server is not installed. Run: npm install -D typescript-language-server typescript' >&2",
		"  exit 127",
		"fi",
	}
	return strings.Join(lines, "\n"), nil
}
