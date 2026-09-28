package terminal

import (
	"testing"

	"golang.org/x/crypto/ssh"
)

// TestResolvePersistentShellKindCachesPerClient verifies the shellKinds
// cache (keyed by *ssh.Client pointer identity) returns the cached value on
// a second call without re-invoking execCommand, using two distinct zero-value
// *ssh.Client pointers as distinct identities. Since a real probe requires a
// live SSH connection (out of scope for a unit test), this only exercises the
// cache-hit path by pre-seeding it directly - the cache-miss path (an actual
// exec) is exercised implicitly by every other package's integration-style
// usage and is not re-tested here without a real remote host.
func TestResolvePersistentShellKindCacheHit(t *testing.T) {
	registry := NewRegistry(nil)
	client := &ssh.Client{}

	registry.mu.Lock()
	registry.shellKinds[client] = ShellKindTmux
	registry.mu.Unlock()

	kind, err := registry.resolvePersistentShellKind(client)
	if err != nil {
		t.Fatalf("resolvePersistentShellKind() error = %v", err)
	}
	if kind != ShellKindTmux {
		t.Errorf("resolvePersistentShellKind() = %q, want tmux (from cache)", kind)
	}
}

// TestShellKindsCacheIsPerClient verifies two distinct *ssh.Client pointers
// get independent cache entries.
func TestShellKindsCacheIsPerClient(t *testing.T) {
	registry := NewRegistry(nil)
	clientA := &ssh.Client{}
	clientB := &ssh.Client{}

	registry.mu.Lock()
	registry.shellKinds[clientA] = ShellKindTmux
	registry.shellKinds[clientB] = ShellKindScreen
	registry.mu.Unlock()

	kindA, err := registry.resolvePersistentShellKind(clientA)
	if err != nil || kindA != ShellKindTmux {
		t.Errorf("clientA kind = %q, err = %v, want tmux", kindA, err)
	}
	kindB, err := registry.resolvePersistentShellKind(clientB)
	if err != nil || kindB != ShellKindScreen {
		t.Errorf("clientB kind = %q, err = %v, want screen", kindB, err)
	}
}
