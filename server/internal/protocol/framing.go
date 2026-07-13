package protocol

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const DefaultMaxMessageSize = 8 * 1024 * 1024

// Reader and Writer implement LSP-style Content-Length framing for JSON-RPC.
// Keeping framing here prevents accidental protocol output on stdout.
type Reader struct {
	input   *bufio.Reader
	maxSize int
}

func NewReader(input io.Reader, maxSize int) *Reader {
	if maxSize <= 0 {
		maxSize = DefaultMaxMessageSize
	}
	return &Reader{input: bufio.NewReader(input), maxSize: maxSize}
}

func (r *Reader) Read() ([]byte, error) {
	length := -1
	for {
		line, err := r.input.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid protocol header")
		}
		if strings.EqualFold(strings.TrimSpace(parts[0]), "Content-Length") {
			value, parseErr := strconv.Atoi(strings.TrimSpace(parts[1]))
			if parseErr != nil || value < 0 || value > r.maxSize {
				return nil, fmt.Errorf("invalid content length")
			}
			length = value
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("missing content length")
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r.input, payload); err != nil {
		return nil, err
	}
	if !json.Valid(payload) {
		return nil, fmt.Errorf("invalid JSON payload")
	}
	return payload, nil
}

type Writer struct {
	output  io.Writer
	maxSize int
}

func NewWriter(output io.Writer, maxSize int) *Writer {
	if maxSize <= 0 {
		maxSize = DefaultMaxMessageSize
	}
	return &Writer{output: output, maxSize: maxSize}
}

func (w *Writer) Write(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) > w.maxSize {
		return fmt.Errorf("message exceeds maximum size")
	}
	_, err = w.output.Write(append([]byte(fmt.Sprintf("Content-Length: %d\r\n\r\n", len(payload))), payload...))
	return err
}

func Encode(value any) []byte {
	payload, _ := json.Marshal(value)
	return append([]byte(nil), payload...)
}
