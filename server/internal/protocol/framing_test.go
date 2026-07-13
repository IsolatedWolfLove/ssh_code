package protocol

import (
	"bytes"
	"io"
	"testing"
)

func TestReaderHandlesSplitAndCombinedFrames(t *testing.T) {
	input := bytes.NewBufferString("Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}Content-Length: 2\r\n\r\n{}")
	reader := NewReader(input, 1024)

	first, err := reader.Read()
	if err != nil || string(first) != `{"jsonrpc":"2.0"}` {
		t.Fatalf("first frame = %q, %v", first, err)
	}
	second, err := reader.Read()
	if err != nil || string(second) != "{}" {
		t.Fatalf("second frame = %q, %v", second, err)
	}
	_, err = reader.Read()
	if err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestReaderRejectsOversizedMessage(t *testing.T) {
	reader := NewReader(bytes.NewBufferString("Content-Length: 9\r\n\r\n"), 8)
	if _, err := reader.Read(); err == nil {
		t.Fatal("expected oversized message error")
	}
}

func TestWriterUsesContentLength(t *testing.T) {
	output := new(bytes.Buffer)
	if err := NewWriter(output, 1024).Write(map[string]string{"ok": "yes"}); err != nil {
		t.Fatal(err)
	}
	if got := output.String(); got != "Content-Length: 12\r\n\r\n{\"ok\":\"yes\"}" {
		t.Fatalf("unexpected frame: %q", got)
	}
}
