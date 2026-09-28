// Package ssh implements the SSH connection, SFTP-session, and error
// classification logic that replaces the Node ssh2-based SshSessionManager
// (src/main/ssh-session.ts) for the Wails backend.
package ssh

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// AuthMethod mirrors contracts.ts's authentication choices.
type AuthMethod string

const (
	AuthPassword   AuthMethod = "password"
	AuthPrivateKey AuthMethod = "privateKey"
	AuthAgent      AuthMethod = "agent"
	AuthTailscale  AuthMethod = "tailscale"
)

// HostVerificationMode mirrors contracts.ts's HostVerificationMode union.
type HostVerificationMode string

const (
	HostVerificationKnownHosts HostVerificationMode = "knownHosts"
	HostVerificationOff        HostVerificationMode = "off"
)

// JumpHostInput mirrors contracts.ts's JumpHostInput.
type JumpHostInput struct {
	Host           string
	Port           int
	Username       string
	AuthMethod     AuthMethod
	Password       string
	PrivateKeyPath string
	Passphrase     string
	AgentSocket    string
}

// ConnectInput builds the SSH transport configuration and auth notifications.
type ConnectInput struct {
	OnAuthMessage    func(string)
	Host             string
	Port             int
	Username         string
	AuthMethod       AuthMethod
	Password         string
	PrivateKeyPath   string
	Passphrase       string
	AgentSocket      string
	HostVerification HostVerificationMode
	KnownHostsPath   string
	JumpHost         *JumpHostInput
}

const defaultReadyTimeout = 15 * time.Second

// buildClientConfig mirrors buildConnectConfig in ssh-session.ts: turns a
// ConnectInput into a *ssh.ClientConfig covering password / private key /
// agent/Tailscale auth and known_hosts verification.
func buildClientConfig(input ConnectInput) (*ssh.ClientConfig, error) {
	authMethod := input.AuthMethod
	if authMethod == "" {
		authMethod = AuthPassword
	}

	config := &ssh.ClientConfig{
		User:    strings.TrimSpace(input.Username),
		Timeout: defaultReadyTimeout,
	}

	hostVerification := input.HostVerification
	if hostVerification == "" {
		hostVerification = HostVerificationOff
	}

	host := strings.TrimSpace(input.Host)
	port := input.Port

	if hostVerification == HostVerificationKnownHosts {
		knownHostsPath := strings.TrimSpace(input.KnownHostsPath)
		if knownHostsPath == "" {
			return nil, errors.New("known_hosts path is required when host verification is enabled")
		}
		config.HostKeyCallback = func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			matched, err := VerifyKnownHosts(host, port, key.Type(), key.Marshal(), knownHostsPath)
			if err != nil || !matched {
				return fmt.Errorf("host key verification failed for %s:%d", host, port)
			}
			return nil
		}
	} else {
		// Mirrors the Electron app's default posture: host verification is
		// opt-in. This is the same trust model as today, not a regression
		// introduced by the rewrite.
		config.HostKeyCallback = ssh.InsecureIgnoreHostKey() //nolint:gosec // opt-in verification, matches existing behavior
	}

	switch authMethod {
	case AuthTailscale:
		config.Timeout = 120 * time.Second
		// SSH tries the none method first; Tailscale uses identity/ACLs.
		config.Auth = []ssh.AuthMethod{ssh.KeyboardInteractive(func(user, instruction string, questions []string, echo []bool) ([]string, error) {
			if input.OnAuthMessage != nil {
				input.OnAuthMessage(instruction + "\n" + strings.Join(questions, "\n"))
			}
			return make([]string, len(questions)), nil
		})}
		config.BannerCallback = func(message string) error {
			if input.OnAuthMessage != nil {
				input.OnAuthMessage(message)
			}
			return nil
		}
		return config, nil
	case AuthPrivateKey:
		privateKeyPath := strings.TrimSpace(input.PrivateKeyPath)
		if privateKeyPath == "" {
			return nil, errors.New("private key path is required")
		}
		keyBytes, err := os.ReadFile(privateKeyPath)
		if err != nil {
			return nil, fmt.Errorf("unable to read private key: %w", err)
		}
		var signer ssh.Signer
		if strings.TrimSpace(input.Passphrase) != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(keyBytes, []byte(input.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(keyBytes)
		}
		if err != nil {
			return nil, fmt.Errorf("cannot parse privateKey: %w", err)
		}
		config.Auth = []ssh.AuthMethod{ssh.PublicKeys(signer)}
		return config, nil

	case AuthAgent:
		agentSocket := strings.TrimSpace(input.AgentSocket)
		if agentSocket == "" {
			agentSocket = os.Getenv("SSH_AUTH_SOCK")
		}
		if agentSocket == "" {
			return nil, errors.New("agent socket is required")
		}
		if _, err := agentSigners(agentSocket); err != nil {
			return nil, fmt.Errorf("unable to connect to agent socket: %w", err)
		}
		config.Auth = []ssh.AuthMethod{ssh.PublicKeysCallback(func() ([]ssh.Signer, error) { return agentSigners(agentSocket) })}
		return config, nil

	default: // AuthPassword
		config.Auth = []ssh.AuthMethod{ssh.Password(input.Password)}
		return config, nil
	}
}

// jumpHostToConnectInput mirrors the '...input, ...input.jumpHost,
// hostVerification: off' spread in ssh-session.ts's connect(): the jump hop
// always uses the jump host's own credentials with host verification
// disabled (jump hosts are typically bastions the user already trusts by
// having entered their address explicitly).
func jumpHostToConnectInput(jump JumpHostInput) ConnectInput {
	return ConnectInput{
		Host:             jump.Host,
		Port:             jump.Port,
		Username:         jump.Username,
		AuthMethod:       jump.AuthMethod,
		Password:         jump.Password,
		PrivateKeyPath:   jump.PrivateKeyPath,
		Passphrase:       jump.Passphrase,
		AgentSocket:      jump.AgentSocket,
		HostVerification: HostVerificationOff,
	}
}
