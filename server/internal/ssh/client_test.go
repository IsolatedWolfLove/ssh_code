package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestBuildClientConfigPasswordAuth(t *testing.T) {
	config, err := buildClientConfig(ConnectInput{
		Host:     "example.com",
		Port:     22,
		Username: "alice",
		Password: "secret",
	})
	if err != nil {
		t.Fatalf("buildClientConfig() error = %v", err)
	}
	if config.User != "alice" {
		t.Errorf("User = %q, want alice", config.User)
	}
	if len(config.Auth) != 1 {
		t.Fatalf("expected exactly one auth method, got %d", len(config.Auth))
	}
	if config.HostKeyCallback == nil {
		t.Error("expected a non-nil HostKeyCallback even when host verification is off")
	}
}

func TestBuildClientConfigPrivateKeyAuth(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "id_ed25519")

	_, private, err := generateTestEd25519Key()
	if err != nil {
		t.Fatalf("generate test key: %v", err)
	}
	if err := os.WriteFile(keyPath, private, 0o600); err != nil {
		t.Fatalf("write test key: %v", err)
	}

	config, err := buildClientConfig(ConnectInput{
		Host:           "example.com",
		Port:           22,
		Username:       "alice",
		AuthMethod:     AuthPrivateKey,
		PrivateKeyPath: keyPath,
	})
	if err != nil {
		t.Fatalf("buildClientConfig() error = %v", err)
	}
	if len(config.Auth) != 1 {
		t.Fatalf("expected exactly one auth method, got %d", len(config.Auth))
	}
}

func TestBuildClientConfigPrivateKeyMissingPath(t *testing.T) {
	_, err := buildClientConfig(ConnectInput{
		Host:       "example.com",
		Port:       22,
		Username:   "alice",
		AuthMethod: AuthPrivateKey,
	})
	if err == nil {
		t.Fatal("expected an error when privateKeyPath is empty")
	}
}

func TestBuildClientConfigAgentMissingSocket(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	_, err := buildClientConfig(ConnectInput{
		Host:       "example.com",
		Port:       22,
		Username:   "alice",
		AuthMethod: AuthAgent,
	})
	if err == nil {
		t.Fatal("expected an error when agentSocket is empty")
	}
}

func TestBuildClientConfigKnownHostsRequiresPath(t *testing.T) {
	_, err := buildClientConfig(ConnectInput{
		Host:             "example.com",
		Port:             22,
		Username:         "alice",
		Password:         "secret",
		HostVerification: HostVerificationKnownHosts,
	})
	if err == nil {
		t.Fatal("expected an error when known_hosts path is empty but verification is enabled")
	}
}

func TestBuildClientConfigTailscale(t *testing.T) {
	config, err := buildClientConfig(ConnectInput{
		Host:       "example.com",
		Port:       22,
		Username:   "alice",
		AuthMethod: AuthTailscale,
	})
	if err != nil || config == nil || len(config.Auth) == 0 {
		t.Fatalf("tailscale auth config: %v", err)
	}
}

// generateTestEd25519Key returns a PEM-encoded ed25519 private key usable
// with ssh.ParsePrivateKey, without depending on external key files.
func generateTestEd25519Key() (ssh.PublicKey, []byte, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}

	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, nil, err
	}

	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		return nil, nil, err
	}

	return signer.PublicKey(), pem.EncodeToMemory(block), nil
}
