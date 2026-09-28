// Package testssh provides an ephemeral loopback SSH/SFTP peer for integration tests.
package testssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func Start(t *testing.T, withSFTP bool) (host string, port int) {
	t.Helper()
	_, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	signer, e := ssh.NewSignerFromKey(key)
	if e != nil {
		t.Fatal(e)
	}
	config := &ssh.ServerConfig{PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { return nil, nil }}
	config.AddHostKey(signer)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	var mu sync.Mutex
	connections := []net.Conn{}
	closed := false
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		closed = true
		for _, c := range connections {
			c.Close()
		}
		mu.Unlock()
	})
	go func() {
		for {
			c, e := listener.Accept()
			if e != nil {
				return
			}
			mu.Lock()
			if closed {
				mu.Unlock()
				c.Close()
				return
			}
			connections = append(connections, c)
			mu.Unlock()
			go serve(c, config, withSFTP)
		}
	}()
	h, p, _ := net.SplitHostPort(listener.Addr().String())
	n, _ := strconv.Atoi(p)
	return h, n
}
func serve(conn net.Conn, config *ssh.ServerConfig, withSFTP bool) {
	defer conn.Close()
	server, channels, requests, e := ssh.NewServerConn(conn, config)
	if e != nil {
		return
	}
	defer server.Close()
	go serveForwardRequests(server, requests)
	for incoming := range channels {
		if incoming.ChannelType() == "direct-tcpip" {
			go func(in ssh.NewChannel) {
				var p struct {
					Host       string
					Port       uint32
					Origin     string
					OriginPort uint32
				}
				if ssh.Unmarshal(in.ExtraData(), &p) != nil {
					in.Reject(ssh.ConnectionFailed, "bad forwarding request")
					return
				}
				remote, e := net.Dial("tcp", net.JoinHostPort(p.Host, strconv.Itoa(int(p.Port))))
				if e != nil {
					in.Reject(ssh.ConnectionFailed, e.Error())
					return
				}
				ch, req, e := in.Accept()
				if e != nil {
					remote.Close()
					return
				}
				go ssh.DiscardRequests(req)
				defer remote.Close()
				defer ch.Close()
				go func() { io.Copy(ch, remote); ch.CloseWrite() }()
				io.Copy(remote, ch)
			}(incoming)
			continue
		}
		if incoming.ChannelType() != "session" {
			incoming.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, req, e := incoming.Accept()
		if e != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for r := range req {
				switch r.Type {
				case "subsystem":
					var p struct{ Name string }
					ssh.Unmarshal(r.Payload, &p)
					if p.Name != "sftp" || !withSFTP {
						r.Reply(false, nil)
						continue
					}
					r.Reply(true, nil)
					s, e := sftp.NewServer(ch)
					if e != nil {
						return
					}
					s.Serve()
					s.Close()
					return
				case "pty-req", "window-change", "env":
					r.Reply(true, nil)
				case "shell":
					r.Reply(true, nil)
					io.Copy(ch, ch)
					return
				case "exec":
					var p struct{ Command string }
					ssh.Unmarshal(r.Payload, &p)
					if runtime.GOOS == "windows" {
						r.Reply(false, nil)
						continue
					}
					r.Reply(true, nil)
					cmd := exec.Command("sh", "-c", p.Command)
					cmd.Stdin = ch
					cmd.Stdout = ch
					cmd.Stderr = ch.Stderr()
					e := cmd.Run()
					code := uint32(0)
					if e != nil {
						code = 1
						if x, ok := e.(*exec.ExitError); ok {
							code = uint32(x.ExitCode())
						}
						fmt.Fprint(ch.Stderr(), e)
					}
					ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
					return
				default:
					r.Reply(false, nil)
				}
			}
		}()
	}
}

func serveForwardRequests(server *ssh.ServerConn, requests <-chan *ssh.Request) {
	listeners := map[string]net.Listener{}
	defer func() {
		for _, l := range listeners {
			l.Close()
		}
	}()
	for r := range requests {
		var p struct {
			Host string
			Port uint32
		}
		if ssh.Unmarshal(r.Payload, &p) != nil {
			r.Reply(false, nil)
			continue
		}
		address := net.JoinHostPort(p.Host, strconv.Itoa(int(p.Port)))
		switch r.Type {
		case "tcpip-forward":
			l, e := net.Listen("tcp", address)
			if e != nil {
				r.Reply(false, nil)
				continue
			}
			listeners[address] = l
			r.Reply(true, nil)
			go func() {
				for {
					c, e := l.Accept()
					if e != nil {
						return
					}
					go func() {
						defer c.Close()
						origin, port, _ := net.SplitHostPort(c.RemoteAddr().String())
						n, _ := strconv.Atoi(port)
						ch, req, e := server.OpenChannel("forwarded-tcpip", ssh.Marshal(struct {
							Host       string
							Port       uint32
							Origin     string
							OriginPort uint32
						}{p.Host, p.Port, origin, uint32(n)}))
						if e != nil {
							return
						}
						defer ch.Close()
						go ssh.DiscardRequests(req)
						go func() { io.Copy(ch, c); ch.CloseWrite() }()
						io.Copy(c, ch)
					}()
				}
			}()
		case "cancel-tcpip-forward":
			if l := listeners[address]; l != nil {
				l.Close()
				delete(listeners, address)
			}
			r.Reply(true, nil)
		default:
			r.Reply(false, nil)
		}
	}
}
