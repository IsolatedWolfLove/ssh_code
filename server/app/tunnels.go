package app

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/IsolatedWolfLove/ssh-studio-server/internal/store"
	"golang.org/x/crypto/ssh"
)

type TunnelState struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}
type TunnelSnapshot struct {
	Config store.SavedTunnelConfig `json:"config"`
	State  TunnelState             `json:"state"`
}
type tunnelRuntime struct {
	mu          sync.Mutex
	listener    net.Listener
	connections map[net.Conn]bool
	state       TunnelState
	closed      bool
}

func (t *tunnelRuntime) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	if t.listener != nil {
		t.listener.Close()
	}
	for c := range t.connections {
		c.Close()
	}
	t.state.Status = "stopped"
}
func (t *tunnelRuntime) track(c net.Conn) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		c.Close()
		return false
	}
	t.connections[c] = true
	return true
}
func (t *tunnelRuntime) forget(c net.Conn) {
	t.mu.Lock()
	delete(t.connections, c)
	t.mu.Unlock()
	c.Close()
}
func (a *App) ListTunnels(savedID string) ([]TunnelSnapshot, error) {
	if a.store == nil {
		return nil, fmt.Errorf("saved-connections store unavailable")
	}
	configs, e := a.store.GetTunnels(savedID)
	if e != nil {
		return nil, e
	}
	out := make([]TunnelSnapshot, 0, len(configs))
	a.servicesMu.Lock()
	defer a.servicesMu.Unlock()
	for _, c := range configs {
		state := TunnelState{ID: c.ID, Status: "stopped"}
		for _, s := range a.services {
			s.mu.Lock()
			t := s.tunnels[c.ID]
			s.mu.Unlock()
			if t != nil {
				t.mu.Lock()
				state = t.state
				t.mu.Unlock()
			}
		}
		out = append(out, TunnelSnapshot{c, state})
	}
	return out, nil
}
func (a *App) SaveTunnel(savedID string, c store.SavedTunnelConfig) error {
	if a.store == nil {
		return fmt.Errorf("saved-connections store unavailable")
	}
	return a.store.SaveTunnel(savedID, c)
}
func (a *App) RemoveTunnel(savedID, id string) error {
	if a.store == nil {
		return fmt.Errorf("saved-connections store unavailable")
	}
	a.servicesMu.Lock()
	ids := []string{}
	for cid := range a.services {
		ids = append(ids, cid)
	}
	a.servicesMu.Unlock()
	for _, cid := range ids {
		a.StopTunnel(cid, id)
	}
	return a.store.RemoveTunnel(savedID, id)
}
func (a *App) tunnelEvent(state TunnelState) {
	a.emit("tunnel:event", map[string]any{"type": "state", "state": state})
}
func (a *App) StartTunnel(connectionID, savedID, id string) error {
	if a.store == nil {
		return fmt.Errorf("saved-connections store unavailable")
	}
	c, e := a.store.GetTunnel(savedID, id)
	if e != nil {
		return e
	}
	s, e := a.getServices(connectionID)
	if e != nil {
		return e
	}
	session, e := a.manager.Get(connectionID)
	if e != nil {
		return e
	}
	client := session.Client()
	s.mu.Lock()
	if t := s.tunnels[id]; t != nil {
		t.close()
	}
	t := &tunnelRuntime{connections: make(map[net.Conn]bool), state: TunnelState{ID: id, Status: "starting"}}
	s.tunnels[id] = t
	s.mu.Unlock()
	a.tunnelEvent(t.state)
	var listener net.Listener
	if c.Kind == store.TunnelKind("remote") {
		listener, e = client.Listen("tcp", net.JoinHostPort(c.RemoteHost, strconv.Itoa(c.RemotePort)))
	} else {
		listener, e = net.Listen("tcp", net.JoinHostPort(c.LocalHost, strconv.Itoa(c.LocalPort)))
	}
	t.mu.Lock()
	if e != nil {
		t.state = TunnelState{ID: id, Status: "error", Message: e.Error()}
		state := t.state
		t.mu.Unlock()
		a.tunnelEvent(state)
		return e
	}
	if t.closed {
		t.mu.Unlock()
		listener.Close()
		return fmt.Errorf("tunnel stopped")
	}
	t.listener = listener
	t.state.Status = "running"
	state := t.state
	t.mu.Unlock()
	a.tunnelEvent(state)
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			if !t.track(conn) {
				return
			}
			go func() {
				defer t.forget(conn)
				target := net.JoinHostPort(c.TargetHost, strconv.Itoa(c.TargetPort))
				var remote net.Conn
				var err error
				if c.Kind == store.TunnelKind("dynamic") {
					remote, err = socksConnect(conn, client)
				} else if c.Kind == store.TunnelKind("remote") {
					remote, err = net.DialTimeout("tcp", target, 15*time.Second)
				} else {
					remote, err = client.Dial("tcp", target)
				}
				if err != nil {
					return
				}
				if !t.track(remote) {
					return
				}
				defer t.forget(remote)
				done := make(chan struct{})
				go func() {
					io.Copy(remote, conn)
					if v, ok := remote.(interface{ CloseWrite() error }); ok {
						v.CloseWrite()
					}
					close(done)
				}()
				io.Copy(conn, remote)
				conn.Close()
				remote.Close()
				<-done
			}()
		}
	}()
	return nil
}
func (a *App) StopTunnel(cid, id string) error {
	s, e := a.getServices(cid)
	if e != nil {
		return nil
	}
	s.mu.Lock()
	t := s.tunnels[id]
	delete(s.tunnels, id)
	s.mu.Unlock()
	if t != nil {
		t.close()
	}
	a.tunnelEvent(TunnelState{ID: id, Status: "stopped"})
	return nil
}
func socksConnect(conn net.Conn, client *ssh.Client) (net.Conn, error) {
	conn.SetDeadline(time.Now().Add(15 * time.Second))
	defer conn.SetDeadline(time.Time{})
	header := make([]byte, 2)
	if _, e := io.ReadFull(conn, header); e != nil {
		return nil, e
	}
	if header[0] != 5 {
		return nil, fmt.Errorf("SOCKS5 required")
	}
	methods := make([]byte, int(header[1]))
	if _, e := io.ReadFull(conn, methods); e != nil {
		return nil, e
	}
	allowed := false
	for _, m := range methods {
		if m == 0 {
			allowed = true
		}
	}
	if !allowed {
		conn.Write([]byte{5, 255})
		return nil, fmt.Errorf("SOCKS authentication unavailable")
	}
	if _, e := conn.Write([]byte{5, 0}); e != nil {
		return nil, e
	}
	request := make([]byte, 4)
	if _, e := io.ReadFull(conn, request); e != nil {
		return nil, e
	}
	if request[0] != 5 || request[1] != 1 {
		conn.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return nil, fmt.Errorf("only SOCKS CONNECT supported")
	}
	var host string
	switch request[3] {
	case 1:
		b := make([]byte, 4)
		if _, e := io.ReadFull(conn, b); e != nil {
			return nil, e
		}
		host = net.IP(b).String()
	case 4:
		b := make([]byte, 16)
		if _, e := io.ReadFull(conn, b); e != nil {
			return nil, e
		}
		host = net.IP(b).String()
	case 3:
		b := make([]byte, 1)
		if _, e := io.ReadFull(conn, b); e != nil {
			return nil, e
		}
		name := make([]byte, int(b[0]))
		if _, e := io.ReadFull(conn, name); e != nil {
			return nil, e
		}
		host = string(name)
	default:
		return nil, fmt.Errorf("unsupported SOCKS address")
	}
	port := make([]byte, 2)
	if _, e := io.ReadFull(conn, port); e != nil {
		return nil, e
	}
	remote, e := client.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(port)))))
	code := byte(0)
	if e != nil {
		code = 5
	}
	_, writeErr := conn.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
	if writeErr != nil && remote != nil {
		remote.Close()
		return nil, writeErr
	}
	return remote, e
}
