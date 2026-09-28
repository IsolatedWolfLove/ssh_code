package lsp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// rpcMessage is the shape used to decode any incoming frame: a request, a
// response, or a notification. Fields are left as json.RawMessage where
// possible so decoding the envelope never fails just because a payload's
// inner shape is unexpected.
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// outboundMessage is the shape used to encode any frame this Client sends:
// a request, a notification, or (when acting as the server side of a
// server-initiated request) a response.
type outboundMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  any             `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("lsp error %d: %s", e.Code, e.Message)
}

// NotificationHandler handles a server-initiated notification (e.g.
// textDocument/publishDiagnostics). params is the raw JSON params object.
type NotificationHandler func(params json.RawMessage)

// RequestHandler responds to a server-initiated request (e.g.
// workspace/configuration). Return the value to send back as the JSON-RPC
// result, or an error to send back as a JSON-RPC error response.
type RequestHandler func(params json.RawMessage) (any, error)

// Client speaks JSON-RPC 2.0 framed per the LSP wire protocol (framing.go)
// over an io.ReadWriteCloser - typically an SSH exec channel whose
// stdin/stdout are wired to a remote language server process, but any
// io.ReadWriteCloser works (see the _test.go files for an in-process fake).
type Client struct {
	rw      io.ReadWriteCloser
	writeMu sync.Mutex

	nextID atomic.Int64

	pendingMu sync.Mutex
	pending   map[string]chan rpcMessage

	notifyMu       sync.Mutex
	notifyHandlers map[string]NotificationHandler

	requestMu       sync.Mutex
	requestHandlers map[string]RequestHandler

	closeOnce sync.Once
	closed    chan struct{}
	readErr   error
}

// NewClient wraps rw and starts its background read loop immediately. Call
// Close when done to stop the loop, release the underlying stream, and
// unblock any pending Request calls with an error.
func NewClient(rw io.ReadWriteCloser) *Client {
	c := &Client{
		rw:              rw,
		pending:         make(map[string]chan rpcMessage),
		notifyHandlers:  make(map[string]NotificationHandler),
		requestHandlers: make(map[string]RequestHandler),
		closed:          make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Request sends a JSON-RPC request and blocks until the matching response
// arrives (matched by id), the Client is closed, or the underlying
// transport fails. A JSON-RPC error response is returned as a Go error
// (whose message includes the LSP error code); the raw result payload is
// returned on success for the caller to decode into whatever shape it
// expects.
func (c *Client) Request(method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	idJSON, err := json.Marshal(id)
	if err != nil {
		return nil, err
	}
	key := string(idJSON)

	respCh := make(chan rpcMessage, 1)
	c.pendingMu.Lock()
	c.pending[key] = respCh
	c.pendingMu.Unlock()
	defer func() {
		c.pendingMu.Lock()
		delete(c.pending, key)
		c.pendingMu.Unlock()
	}()

	if err := c.send(outboundMessage{ID: idJSON, Method: method, Params: params}); err != nil {
		return nil, err
	}

	select {
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("language server request timed out: %s", method)
	case msg := <-respCh:
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-c.closed:
		if c.readErr != nil {
			return nil, c.readErr
		}
		return nil, errors.New("lsp client closed")
	}
}

// Notify sends a JSON-RPC notification (no response expected).
func (c *Client) Notify(method string, params any) error {
	return c.send(outboundMessage{Method: method, Params: params})
}

// OnNotification registers handler for every server-initiated notification
// named method (e.g. "textDocument/publishDiagnostics"). Registering again
// for the same method replaces the previous handler.
func (c *Client) OnNotification(method string, handler NotificationHandler) {
	c.notifyMu.Lock()
	c.notifyHandlers[method] = handler
	c.notifyMu.Unlock()
}

// OnRequest registers handler for every server-initiated request named
// method (e.g. "workspace/configuration"). Registering again for the same
// method replaces the previous handler. A method with no registered
// handler is answered with a JSON-RPC "method not found" error.
func (c *Client) OnRequest(method string, handler RequestHandler) {
	c.requestMu.Lock()
	c.requestHandlers[method] = handler
	c.requestMu.Unlock()
}

// OnClose registers handler to run exactly once, in its own goroutine, when
// the read loop exits for any reason: the remote side closed the
// connection, a framing/protocol error occurred, or Close was called
// locally. handler receives the error that caused the loop to exit (nil if
// none was recorded).
func (c *Client) OnClose(handler func(err error)) {
	go func() {
		<-c.closed
		handler(c.readErr)
	}()
}

// Close closes the underlying transport, which causes the read loop to
// observe an error/EOF and unblock any pending Request calls. Safe to call
// more than once; only the first call's result is returned.
func (c *Client) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.rw.Close()
	})
	return err
}

func (c *Client) send(msg outboundMessage) error {
	msg.JSONRPC = "2.0"
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteMessage(c.rw, payload)
}

func (c *Client) readLoop() {
	reader := bufio.NewReader(c.rw)
	for {
		payload, err := ReadMessage(reader)
		if err != nil {
			c.readErr = err
			c.failAllPending(err)
			close(c.closed)
			return
		}

		var msg rpcMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			// A malformed frame should not take down the whole loop -
			// skip it and keep reading, matching a defensive JSON-RPC
			// client rather than crashing on one bad message.
			continue
		}

		hasID := len(msg.ID) > 0 && string(msg.ID) != "null"
		switch {
		case hasID && msg.Method == "":
			c.dispatchResponse(msg)
		case hasID && msg.Method != "":
			go c.handleServerRequest(msg)
		default:
			c.dispatchNotification(msg)
		}
	}
}

func (c *Client) dispatchResponse(msg rpcMessage) {
	key := string(msg.ID)
	c.pendingMu.Lock()
	ch, ok := c.pending[key]
	c.pendingMu.Unlock()
	if ok {
		ch <- msg
	}
}

func (c *Client) dispatchNotification(msg rpcMessage) {
	c.notifyMu.Lock()
	handler, ok := c.notifyHandlers[msg.Method]
	c.notifyMu.Unlock()
	if ok {
		handler(msg.Params)
	}
}

func (c *Client) handleServerRequest(msg rpcMessage) {
	c.requestMu.Lock()
	handler, ok := c.requestHandlers[msg.Method]
	c.requestMu.Unlock()

	if !ok {
		_ = c.send(outboundMessage{ID: msg.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + msg.Method}})
		return
	}

	result, err := handler(msg.Params)
	if err != nil {
		_ = c.send(outboundMessage{ID: msg.ID, Error: &rpcError{Code: -32603, Message: err.Error()}})
		return
	}
	_ = c.send(outboundMessage{ID: msg.ID, Result: result})
}

func (c *Client) failAllPending(err error) {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	for key, ch := range c.pending {
		ch <- rpcMessage{Error: &rpcError{Code: -32000, Message: err.Error()}}
		delete(c.pending, key)
	}
}
