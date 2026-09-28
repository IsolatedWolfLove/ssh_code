// Package lsp implements a remote language-server proxy: a minimal
// LSP-over-JSON-RPC-2.0 client (framing.go, client.go) plus a session
// manager (manager.go) and remote-path<->file-URI helpers (uri.go),
// replacing RemoteLanguageServerManager (src/main/language-server-manager.ts)
// for the Wails backend.
//
// The remote language server process itself is started by the integration
// layer, which owns the SSH exec channel and hands this package the
// channel's stdin/stdout as a plain io.ReadWriteCloser - nothing in this
// package depends on internal/ssh, so it is equally testable against an
// in-process fake "server" (see the _test.go files) as against a real
// remote process.
package lsp

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// WriteMessage frames payload per the LSP wire protocol used by
// vscode-jsonrpc's StreamMessageWriter on the original Node side: a
// Content-Length header, a blank line, then the raw payload bytes.
func WriteMessage(w io.Writer, payload []byte) error {
	header := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(payload))
	if _, err := io.WriteString(w, header); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadMessage reads one framed LSP message from r: headers terminated by a
// blank line (any header besides Content-Length, e.g. Content-Type, is
// read and ignored), then exactly Content-Length bytes of payload. Mirrors
// what vscode-jsonrpc's StreamMessageReader does when parsing frames from a
// remote language server's stdout.
func ReadMessage(r *bufio.Reader) ([]byte, error) {
	contentLength := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}

		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, fmt.Errorf("invalid Content-Length header %q: %w", value, err)
			}
			contentLength = n
		}
	}

	if contentLength < 0 {
		return nil, fmt.Errorf("missing Content-Length header")
	}

	payload := make([]byte, contentLength)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}
