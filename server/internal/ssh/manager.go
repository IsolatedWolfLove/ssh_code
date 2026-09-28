package ssh

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"

	fs "github.com/IsolatedWolfLove/ssh-studio-server/internal/sftp"
	"github.com/pkg/sftp"
	gossh "golang.org/x/crypto/ssh"
	"net"
	"strconv"
)

// ConnectResult mirrors contracts.ts's ConnectResult.
type ConnectResult struct {
	ConnectionID    string
	HomeDir         string
	FilesystemState string // RemoteFileSystemState: 'idle' | 'loading' | 'ready' | 'error'
}

// Manager owns every live Session, keyed by connection ID. This is the
// "single window, multiple connections" scoping decided in the plan: unlike
// the Electron app's one-SshSessionManager-per-BrowserWindow model, a single
// Manager instance serves the whole Wails app, and callers address a
// specific connection by ID (similar to browser tabs).
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

// NewManager creates an empty Manager.
func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

func newConnectionID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	// Mirror the shape of a UUID closely enough for the frontend's purposes
	// (it treats connectionId as an opaque string) without pulling in a UUID
	// dependency for this alone.
	return hex.EncodeToString(buf[:4]) + "-" + hex.EncodeToString(buf[4:6]) + "-" +
		hex.EncodeToString(buf[6:8]) + "-" + hex.EncodeToString(buf[8:10]) + "-" + hex.EncodeToString(buf[10:16])
}

// Connect establishes a new SSH connection (and, if requested, a jump-host
// hop and an SFTP subsystem), mirroring SshSessionManager.connect. On success
// the new Session is registered under a fresh connection ID and returned; on
// failure everything opened along the way is torn down before returning an
// error (the caller is expected to classify it with ClassifyConnectionError).
func (m *Manager) Connect(input ConnectInput) (ConnectResult, error) {
	config, err := buildClientConfig(input)
	if err != nil {
		return ConnectResult{}, err
	}

	var jumpClient *gossh.Client
	addr := net.JoinHostPort(input.Host, strconv.Itoa(input.Port))

	if input.JumpHost != nil {
		jumpConfig, err := buildClientConfig(jumpHostToConnectInput(*input.JumpHost))
		if err != nil {
			return ConnectResult{}, err
		}
		jumpAddr := net.JoinHostPort(input.JumpHost.Host, strconv.Itoa(input.JumpHost.Port))
		jumpClient, err = gossh.Dial("tcp", jumpAddr, jumpConfig)
		if err != nil {
			return ConnectResult{}, err
		}
	}

	var client *gossh.Client
	if jumpClient != nil {
		conn, err := dialJump(jumpClient, input.Host, input.Port)
		if err != nil {
			jumpClient.Close()
			return ConnectResult{}, err
		}
		sshConn, chans, reqs, err := gossh.NewClientConn(conn, addr, config)
		if err != nil {
			conn.Close()
			jumpClient.Close()
			return ConnectResult{}, err
		}
		client = gossh.NewClient(sshConn, chans, reqs)
	} else {
		client, err = gossh.Dial("tcp", addr, config)
		if err != nil {
			return ConnectResult{}, err
		}
	}

	session := &Session{
		ID:         newConnectionID(),
		Host:       input.Host,
		Username:   input.Username,
		client:     client,
		jumpClient: jumpClient,
	}

	// Best-effort SFTP subsystem, mirroring initializePrimaryFilesystem: a
	// failure here is not fatal to the connection, just falls back to shell
	// commands for file operations (session.SFTP() returns nil in that case).
	filesystemState := "ready"
	if sftpClient, sftpErr := sftp.NewClient(client); sftpErr == nil {
		session.sftp = &fs.Client{Client: sftpClient}
	} else {
		session.sftp = &fs.ShellClient{Client: client}
	}

	session.homeDir = session.ResolveHomeDir()

	m.mu.Lock()
	m.sessions[session.ID] = session
	m.mu.Unlock()

	return ConnectResult{
		ConnectionID:    session.ID,
		HomeDir:         session.homeDir,
		FilesystemState: filesystemState,
	}, nil
}

// Get returns the session for connectionID, or an error if it does not
// exist (e.g. already disconnected, or the frontend passed a stale ID).
func (m *Manager) Get(connectionID string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[connectionID]
	if !ok {
		return nil, fmt.Errorf("no active SSH connection for id %s", connectionID)
	}
	return session, nil
}

// Disconnect closes and removes the session for connectionID. Mirrors
// SshSessionManager.disconnect's client-teardown portion (terminal/tunnel/etc.
// cleanup for other subsystems is out of scope for Phase 1 and lives in the
// callers that own those subsystems).
func (m *Manager) Disconnect(connectionID string) error {
	m.mu.Lock()
	session, ok := m.sessions[connectionID]
	if ok {
		delete(m.sessions, connectionID)
	}
	m.mu.Unlock()

	if !ok {
		return nil
	}

	session.mu.Lock()
	if closer, ok := session.sftp.(interface{ Close() error }); ok {
		_ = closer.Close()
	}
	if session.client != nil {
		_ = session.client.Close()
	}
	if session.jumpClient != nil {
		_ = session.jumpClient.Close()
	}
	session.mu.Unlock()

	return nil
}
