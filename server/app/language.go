package app

import (
	"bytes"
	"encoding/json"
	"io"
	"sync"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/lsp"
	"golang.org/x/crypto/ssh"
)

type LanguageStart struct {
	WorkspacePath string `json:"workspacePath"`
	Language      string `json:"language"`
}
type LanguageResult struct {
	SessionID     string `json:"sessionId"`
	WorkspacePath string `json:"workspacePath"`
	Language      string `json:"language"`
}
type LanguageDocument struct {
	SessionID      string              `json:"sessionId"`
	RemotePath     string              `json:"remotePath"`
	LanguageID     string              `json:"languageId"`
	Version        int                 `json:"version"`
	Text           string              `json:"text"`
	ContentChanges []lsp.ContentChange `json:"contentChanges"`
	Feature        string              `json:"feature"`
	Position       lsp.Position        `json:"position"`
}
type languageTransport struct {
	io.Reader
	io.WriteCloser
	session *ssh.Session
}

func (t *languageTransport) Close() error { _ = t.WriteCloser.Close(); return t.session.Close() }
func (a *App) StartLanguageServer(id string, input LanguageStart) (LanguageResult, error) {
	services, e := a.getServices(id)
	if e != nil {
		return LanguageResult{}, e
	}
	s, e := a.manager.Get(id)
	if e != nil {
		return LanguageResult{}, e
	}
	command, e := lsp.StartCommand(input.WorkspacePath, input.Language)
	if e != nil {
		return LanguageResult{}, e
	}
	ch, e := s.Client().NewSession()
	if e != nil {
		return LanguageResult{}, e
	}
	in, e := ch.StdinPipe()
	if e != nil {
		ch.Close()
		return LanguageResult{}, e
	}
	out, e := ch.StdoutPipe()
	if e != nil {
		ch.Close()
		return LanguageResult{}, e
	}
	var stderr languageStderr
	ch.Stderr = &stderr
	if e = ch.Start(command); e != nil {
		ch.Close()
		return LanguageResult{}, e
	}
	sid, e := services.language.StartSession(&languageTransport{out, in, ch}, input.WorkspacePath, input.Language, func(v lsp.DiagnosticsEvent) { a.emit("languageServer:diagnostics", v) }, func(v lsp.StateEvent) { a.emit("languageServer:state", v) })
	if e != nil && lsp.IsUnavailableMessage(stderr.String()) {
		a.emit("languageServer:state", lsp.StateEvent{WorkspacePath: input.WorkspacePath, Language: input.Language, Status: "unavailable", Message: stderr.String()})
	}
	return LanguageResult{sid, input.WorkspacePath, input.Language}, e
}
func (a *App) StopLanguageServer(id, sid string) error {
	s, e := a.getServices(id)
	if e != nil {
		return nil
	}
	return s.language.StopSession(sid)
}
func (a *App) OpenLanguageDocument(id string, v LanguageDocument) error {
	s, e := a.getServices(id)
	if e != nil {
		return e
	}
	return s.language.OpenDocument(v.SessionID, v.RemotePath, v.LanguageID, v.Version, v.Text)
}
func (a *App) ChangeLanguageDocument(id string, v LanguageDocument) error {
	s, e := a.getServices(id)
	if e != nil {
		return e
	}
	return s.language.ChangeDocument(v.SessionID, v.RemotePath, v.Version, v.ContentChanges)
}
func (a *App) SaveLanguageDocument(id string, v LanguageDocument) error {
	s, e := a.getServices(id)
	if e != nil {
		return e
	}
	return s.language.SaveDocument(v.SessionID, v.RemotePath)
}
func (a *App) CloseLanguageDocument(id string, v LanguageDocument) error {
	s, e := a.getServices(id)
	if e != nil {
		return e
	}
	return s.language.CloseDocument(v.SessionID, v.RemotePath)
}
func (a *App) RequestLanguageFeature(id string, v LanguageDocument) (json.RawMessage, error) {
	s, e := a.getServices(id)
	if e != nil {
		return nil, e
	}
	return s.language.RequestFeature(v.SessionID, v.RemotePath, v.Feature, v.Position)
}

type languageStderr struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *languageStderr) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buffer.Len() < 65536 {
		_, _ = b.buffer.Write(p)
	}
	return len(p), nil
}
func (b *languageStderr) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.buffer.String() }
