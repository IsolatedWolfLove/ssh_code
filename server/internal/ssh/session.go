package ssh

import (
	"fmt"
	"net"
	"strings"
	"sync"

	fs "github.com/IsolatedWolfLove/ssh-studio-server/internal/sftp"
	gossh "golang.org/x/crypto/ssh"
)

// CommandResult mirrors ssh-session.ts's RemoteCommandResult (the tuple
// returned by execRemoteCommand).
type CommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Session holds one live SSH connection (plus an optional jump-host hop and
// an SFTP subsystem client), scoped by connection ID. Mirrors the per-window
// SshSessionManager's interactiveClient/jumpClient/sftp fields, but scoped
// per-connection instead of per-window (see the plan's "single window,
// multiple connections" decision).
type Session struct {
	mu sync.Mutex

	ID       string
	Host     string
	Username string

	client     *gossh.Client
	jumpClient *gossh.Client
	sftp       fs.FileSystem

	homeDir string
}

// Client returns the underlying interactive *ssh.Client. Exists so other
// packages (terminal, sftp helpers living in app/) can open channels without
// this package having to expose every operation itself.
func (s *Session) Client() *gossh.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client
}

// SFTP returns the underlying *sftp.Client, or nil if the SFTP subsystem
// failed to start for this session (mirrors ssh-session.ts's shell-fallback
// path when this.sftp is null).
func (s *Session) SFTP() fs.FileSystem {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sftp
}

// HomeDir returns the resolved home directory, if any.
func (s *Session) HomeDir() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.homeDir
}

// ExecRemoteCommand runs command over a fresh exec channel and collects its
// stdout/stderr/exit code. Mirrors execRemoteCommand in ssh-session.ts.
func (s *Session) ExecRemoteCommand(command string) (CommandResult, error) {
	client := s.Client()
	if client == nil {
		return CommandResult{}, fmt.Errorf("no active SSH connection")
	}

	sess, err := client.NewSession()
	if err != nil {
		return CommandResult{}, err
	}
	defer sess.Close()

	var stdout, stderr strings.Builder
	sess.Stdout = &stdout
	sess.Stderr = &stderr

	exitCode := 0
	if err := sess.Run(command); err != nil {
		if exitErr, ok := err.(*gossh.ExitError); ok {
			exitCode = exitErr.ExitStatus()
		} else if _, ok := err.(*gossh.ExitMissingError); ok {
			exitCode = -1
		} else {
			return CommandResult{}, err
		}
	}

	return CommandResult{
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		ExitCode: exitCode,
	}, nil
}

// ResolveHomeDir mirrors resolveHomeDirectory (SFTP realpath) with a shell
// fallback mirroring resolveHomeDirectoryWithShell (pwd -P).
func (s *Session) ResolveHomeDir() string {
	if client := s.SFTP(); client != nil {
		if c, ok := client.(interface{ RealPath(string) (string, error) }); ok {
			if abs, err := c.RealPath("."); err == nil && abs != "" {
				return abs
			}
		}
	}

	result, err := s.ExecRemoteCommand("pwd -P")
	if err != nil || result.ExitCode != 0 {
		return "/"
	}
	trimmed := strings.TrimSpace(result.Stdout)
	if trimmed == "" {
		return "/"
	}
	return trimmed
}

// dialJump opens a forwarded TCP stream through client to host:port, for use
// as the net.Conn backing a jump-hosted *ssh.Client. Mirrors createJumpStream
// in ssh-session.ts (client.forwardOut).
func dialJump(client *gossh.Client, host string, port int) (net.Conn, error) {
	return client.Dial("tcp", fmt.Sprintf("%s:%d", host, port))
}
