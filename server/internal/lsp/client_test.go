package lsp

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// pipeRWC glues a separately-directioned reader and writer into a single
// io.ReadWriteCloser, so two of them (see newPipePair) form a bidirectional
// in-process channel for testing Client against a hand-written fake peer,
// without needing a real SSH connection or language server process.
type pipeRWC struct {
	r     io.Reader
	w     io.Writer
	close func() error
}

func (p pipeRWC) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p pipeRWC) Write(b []byte) (int, error) { return p.w.Write(b) }
func (p pipeRWC) Close() error {
	if p.close != nil {
		return p.close()
	}
	return nil
}

func newPipePair() (client io.ReadWriteCloser, server io.ReadWriteCloser) {
	ar, aw := io.Pipe()
	br, bw := io.Pipe()
	client = pipeRWC{r: br, w: aw, close: func() error {
		_ = aw.Close()
		_ = br.Close()
		return nil
	}}
	server = pipeRWC{r: ar, w: bw, close: func() error {
		_ = bw.Close()
		_ = ar.Close()
		return nil
	}}
	return client, server
}

func TestClientRequestGetsMatchingResponse(t *testing.T) {
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
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal(payload, &req)
		if req.Method != "initialize" {
			return
		}
		resp, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(req.ID),
			"result":  map[string]any{"capabilities": map[string]any{}},
		})
		_ = WriteMessage(serverRWC, resp)
	}()

	client := NewClient(clientRWC)
	defer client.Close()

	result, err := client.Request("initialize", map[string]any{"processId": nil})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if !strings.Contains(string(result), "capabilities") {
		t.Fatalf("unexpected result: %s", result)
	}
}

func TestClientDeliversServerNotification(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	client := NewClient(clientRWC)
	defer client.Close()

	received := make(chan json.RawMessage, 1)
	client.OnNotification("textDocument/publishDiagnostics", func(params json.RawMessage) {
		received <- params
	})

	notification, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "textDocument/publishDiagnostics",
		"params":  map[string]any{"uri": "file:///tmp/a.ts", "diagnostics": []any{}},
	})
	if err := WriteMessage(serverRWC, notification); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	select {
	case params := <-received:
		if !strings.Contains(string(params), "file:///tmp/a.ts") {
			t.Fatalf("unexpected params: %s", params)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for notification")
	}
}

func TestClientAnswersServerInitiatedRequest(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	client := NewClient(clientRWC)
	defer client.Close()
	client.OnRequest("workspace/configuration", func(params json.RawMessage) (any, error) {
		return []any{nil}, nil
	})

	req, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "workspace/configuration",
		"params":  map[string]any{"items": []any{map[string]any{}}},
	})
	if err := WriteMessage(serverRWC, req); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	payload, err := ReadMessage(bufio.NewReader(serverRWC))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	var resp struct {
		ID     int   `json:"id"`
		Result []any `json:"result"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if resp.ID != 7 || len(resp.Result) != 1 {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestClientUnknownServerRequestGetsMethodNotFound(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	client := NewClient(clientRWC)
	defer client.Close()

	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "totally/unknown"})
	if err := WriteMessage(serverRWC, req); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	payload, err := ReadMessage(bufio.NewReader(serverRWC))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	var resp struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if resp.Error == nil || resp.Error.Code != -32601 {
		t.Fatalf("expected a method-not-found error, got %+v", resp.Error)
	}
}

func TestClientCloseUnblocksPendingRequest(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer serverRWC.Close()

	client := NewClient(clientRWC)

	errCh := make(chan error, 1)
	go func() {
		_, err := client.Request("initialize", nil)
		errCh <- err
	}()

	time.Sleep(20 * time.Millisecond) // let the request register before closing
	_ = client.Close()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected an error after Close, got nil")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Close to unblock the pending request")
	}
}

func TestClientConcurrentRequestsMatchIndependently(t *testing.T) {
	clientRWC, serverRWC := newPipePair()
	defer clientRWC.Close()
	defer serverRWC.Close()

	go func() {
		reader := bufio.NewReader(serverRWC)
		for i := 0; i < 2; i++ {
			payload, err := ReadMessage(reader)
			if err != nil {
				return
			}
			var req struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			_ = json.Unmarshal(payload, &req)
			resp, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(req.ID),
				"result":  req.Method,
			})
			_ = WriteMessage(serverRWC, resp)
		}
	}()

	client := NewClient(clientRWC)
	defer client.Close()

	methods := []string{"textDocument/hover", "textDocument/completion"}
	results := make([]string, len(methods))
	var wg sync.WaitGroup
	for i, method := range methods {
		wg.Add(1)
		go func(i int, method string) {
			defer wg.Done()
			result, err := client.Request(method, nil)
			if err != nil {
				t.Errorf("Request(%s): %v", method, err)
				return
			}
			_ = json.Unmarshal(result, &results[i])
		}(i, method)
	}
	wg.Wait()

	for i, method := range methods {
		if results[i] != method {
			t.Fatalf("result[%d] = %q, want %q", i, results[i], method)
		}
	}
}
