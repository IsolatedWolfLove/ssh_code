package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/protocol"
)

const protocolVersion = "1.0"

var (
	version   = "dev"
	commit    = "unknown"
	buildTime = "unknown"
)

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type session struct {
	instanceID string
	startedAt  time.Time
	helloDone  bool
}

func main() {
	defer func() {
		if recovered := recover(); recovered != nil {
			logError("panic", fmt.Sprint(recovered))
			os.Exit(1)
		}
	}()

	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("ssh-studio-server %s (%s, %s)\n", version, commit, buildTime)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "self-test" {
		if err := selfTest(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) < 2 || os.Args[1] != "session" {
		fmt.Fprintln(os.Stderr, "usage: ssh-studio-server session --stdio --workspace <absolute-path>")
		os.Exit(2)
	}

	flags := flag.NewFlagSet("session", flag.ExitOnError)
	stdio := flags.Bool("stdio", false, "use stdin/stdout transport")
	workspace := flags.String("workspace", "", "authorized workspace path")
	_ = flags.Parse(os.Args[2:])
	if !*stdio || !strings.HasPrefix(*workspace, "/") {
		fmt.Fprintln(os.Stderr, "session requires --stdio and an absolute --workspace")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runSession(ctx, os.Stdin, os.Stdout); err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		logError("session", err.Error())
		os.Exit(1)
	}
}

func runSession(ctx context.Context, input io.Reader, output io.Writer) error {
	reader := protocol.NewReader(input, protocol.DefaultMaxMessageSize)
	writer := protocol.NewWriter(output, protocol.DefaultMaxMessageSize)
	s := session{instanceID: randomID(), startedAt: time.Now().UTC()}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		payload, err := reader.Read()
		if err != nil {
			return err
		}
		var request request
		if err := json.Unmarshal(payload, &request); err != nil {
			return err
		}
		if request.JSONRPC != "2.0" || request.Method == "" {
			if err := writer.Write(errorResponse(request.ID, -32600, "Invalid Request")); err != nil {
				return err
			}
			continue
		}
		if len(request.ID) == 0 {
			continue
		}

		response, shutdown := s.handle(request)
		if err := writer.Write(response); err != nil {
			return err
		}
		if shutdown {
			return nil
		}
	}
}

func (s *session) handle(req request) (response, bool) {
	if !s.helloDone && req.Method != "system/hello" {
		return errorResponse(req.ID, -32001, "HandshakeRequired"), false
	}
	switch req.Method {
	case "system/hello":
		s.helloDone = true
		return success(req.ID, map[string]any{
			"serverVersion": version, "protocolVersion": protocolVersion, "os": runtime.GOOS,
			"arch": runtime.GOARCH, "instanceId": s.instanceID, "startedAt": s.startedAt.Format(time.RFC3339),
			"capabilities": []string{"system.hello", "system.ping", "system.health", "system.capabilities", "system.shutdown"},
			"limits":       map[string]int{"maxMessageSize": protocol.DefaultMaxMessageSize},
		}), false
	case "system/ping":
		return success(req.ID, map[string]string{"instanceId": s.instanceID, "status": "ok"}), false
	case "system/health":
		return success(req.ID, map[string]any{"status": "ok", "uptimeMs": time.Since(s.startedAt).Milliseconds()}), false
	case "system/capabilities":
		return success(req.ID, []string{"system.hello", "system.ping", "system.health", "system.capabilities", "system.shutdown"}), false
	case "system/shutdown":
		return success(req.ID, nil), true
	default:
		return errorResponse(req.ID, -32601, "MethodNotFound"), false
	}
}

func success(id json.RawMessage, result any) response {
	return response{JSONRPC: "2.0", ID: id, Result: result}
}
func errorResponse(id json.RawMessage, code int, message string) response {
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}}
}

func randomID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes)
}

func logError(event, message string) {
	payload, _ := json.Marshal(map[string]string{"level": "error", "event": event, "message": message})
	fmt.Fprintln(os.Stderr, string(payload))
}

func selfTest() error {
	if protocol.DefaultMaxMessageSize != 8*1024*1024 {
		return fmt.Errorf("unexpected protocol limit")
	}
	return nil
}
