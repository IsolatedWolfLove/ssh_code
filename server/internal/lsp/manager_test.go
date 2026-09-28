package lsp

import (
	"bufio"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStartSessionHandshakeAndDiagnostics(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		reader := bufio.NewReader(serverRWC)

		payload, err := ReadMessage(reader)
		if err != nil {
			return
		}
		var initReq struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(payload, &initReq)
		resp, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(initReq.ID),
			"result":  map[string]any{"capabilities": map[string]any{}},
		})
		if err := WriteMessage(serverRWC, resp); err != nil {
			return
		}

		if _, err := ReadMessage(reader); err != nil { // "initialized" notification
			return
		}

		openPayload, err := ReadMessage(reader)
		if err != nil {
			return
		}
		var openMsg struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(openPayload, &openMsg)
		if openMsg.Method != "textDocument/didOpen" {
			return
		}

		diagnostics, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  "textDocument/publishDiagnostics",
			"params": map[string]any{
				"uri": "file:///workspace/app.ts",
				"diagnostics": []any{
					map[string]any{
						"range": map[string]any{
							"start": map[string]any{"line": 0, "character": 0},
							"end":   map[string]any{"line": 0, "character": 1},
						},
						"severity": 1,
						"message":  "unexpected token",
					},
				},
			},
		})
		_ = WriteMessage(serverRWC, diagnostics)
	}()

	manager := NewManager()
	states := make(chan StateEvent, 8)
	diagnosticsCh := make(chan DiagnosticsEvent, 1)

	sessionID, err := manager.StartSession(clientRWC, "/workspace", "typescript",
		func(event DiagnosticsEvent) { diagnosticsCh <- event },
		func(event StateEvent) { states <- event },
	)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if sessionID == "" {
		t.Fatal("expected a non-empty session id")
	}

	var sawReady bool
	for i := 0; i < 2; i++ {
		select {
		case state := <-states:
			if state.Status == "ready" {
				sawReady = true
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for state events")
		}
	}
	if !sawReady {
		t.Fatal("expected a 'ready' state event")
	}

	if err := manager.OpenDocument(sessionID, "/workspace/app.ts", "typescript", 1, "const x = 1;"); err != nil {
		t.Fatalf("OpenDocument: %v", err)
	}

	select {
	case event := <-diagnosticsCh:
		if event.RemotePath != "/workspace/app.ts" {
			t.Fatalf("unexpected remote path: %s", event.RemotePath)
		}
		if len(event.Diagnostics) != 1 || event.Diagnostics[0].Message != "unexpected token" {
			t.Fatalf("unexpected diagnostics: %+v", event.Diagnostics)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for diagnostics")
	}

	select {
	case <-serverDone:
	case <-time.After(time.Second):
		t.Fatal("fake server goroutine did not finish")
	}
}

func TestStartSessionReusesExistingSession(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	go func() {
		reader := bufio.NewReader(serverRWC)
		payload, err := ReadMessage(reader)
		if err != nil {
			return
		}
		var req struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(payload, &req)
		resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID), "result": map[string]any{}})
		_ = WriteMessage(serverRWC, resp)
		_, _ = ReadMessage(reader) // initialized notification
	}()

	manager := NewManager()
	id1, err := manager.StartSession(clientRWC, "/workspace", "typescript", nil, nil)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	id2, err := manager.StartSession(clientRWC, "/workspace", "typescript", nil, nil)
	if err != nil {
		t.Fatalf("StartSession (reuse): %v", err)
	}
	if id1 != id2 {
		t.Fatalf("expected the second StartSession for the same workspace/language to reuse the session, got %q and %q", id1, id2)
	}
}

func TestStartSessionUnavailableWhenInitializeFails(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()

	go func() {
		reader := bufio.NewReader(serverRWC)
		payload, err := ReadMessage(reader)
		if err != nil {
			return
		}
		var req struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(payload, &req)
		resp, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(req.ID),
			"error":   map[string]any{"code": -32000, "message": "typescript-language-server is not installed"},
		})
		_ = WriteMessage(serverRWC, resp)
		_ = serverRWC.Close()
	}()

	manager := NewManager()
	var states []StateEvent
	_, err := manager.StartSession(clientRWC, "/workspace", "typescript", nil, func(event StateEvent) {
		states = append(states, event)
	})
	if err == nil {
		t.Fatal("expected StartSession to fail when initialize returns an error")
	}
	if !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("unexpected error: %v", err)
	}

	var sawUnavailable bool
	for _, state := range states {
		if state.Status == "unavailable" {
			sawUnavailable = true
		}
	}
	if !sawUnavailable {
		t.Fatalf("expected an 'unavailable' state event, got %+v", states)
	}
}

func TestChangeDocumentRequiresPriorOpen(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	go func() {
		reader := bufio.NewReader(serverRWC)
		payload, err := ReadMessage(reader)
		if err != nil {
			return
		}
		var req struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(payload, &req)
		resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID), "result": map[string]any{}})
		_ = WriteMessage(serverRWC, resp)
		_, _ = ReadMessage(reader)
	}()

	manager := NewManager()
	sessionID, err := manager.StartSession(clientRWC, "/workspace", "typescript", nil, nil)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if err := manager.ChangeDocument(sessionID, "/workspace/app.ts", 2, nil); err == nil {
		t.Fatal("expected ChangeDocument to fail for a document that was never opened")
	}
}
