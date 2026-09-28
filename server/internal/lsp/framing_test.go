package lsp

import (
	"bufio"
	"bytes"
	"io"
	"strconv"
	"strings"
	"testing"
)

func TestWriteMessageThenReadMessageRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	payload := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if err := WriteMessage(&buf, payload); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	got, err := ReadMessage(bufio.NewReader(&buf))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("got %q, want %q", got, payload)
	}
}

func TestReadMessageMissingContentLength(t *testing.T) {
	raw := "Content-Type: application/vscode-jsonrpc\r\n\r\n{}"
	if _, err := ReadMessage(bufio.NewReader(strings.NewReader(raw))); err == nil {
		t.Fatal("expected an error for a missing Content-Length header")
	}
}

func TestReadMessageInvalidContentLength(t *testing.T) {
	raw := "Content-Length: not-a-number\r\n\r\n"
	if _, err := ReadMessage(bufio.NewReader(strings.NewReader(raw))); err == nil {
		t.Fatal("expected an error for a non-numeric Content-Length header")
	}
}

func TestReadMessageIgnoresExtraHeaders(t *testing.T) {
	payload := []byte(`{"jsonrpc":"2.0","id":2,"result":null}`)
	raw := "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: " +
		strconv.Itoa(len(payload)) + "\r\n\r\n" + string(payload)

	got, err := ReadMessage(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("got %q, want %q", got, payload)
	}
}

// slowReader trickles bytes one at a time, exercising ReadMessage's handling
// of a payload that arrives across several Read() calls rather than one.
type slowReader struct {
	data []byte
	pos  int
}

func (r *slowReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.pos]
	r.pos++
	return 1, nil
}

func TestReadMessageHandlesChunkedInput(t *testing.T) {
	payload := []byte(`{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"ok":true}}`)
	var buf bytes.Buffer
	if err := WriteMessage(&buf, payload); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	got, err := ReadMessage(bufio.NewReader(&slowReader{data: buf.Bytes()}))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("got %q, want %q", got, payload)
	}
}

func TestWriteMessageEmptyPayload(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteMessage(&buf, []byte{}); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}
	got, err := ReadMessage(bufio.NewReader(&buf))
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %q, want empty payload", got)
	}
}
