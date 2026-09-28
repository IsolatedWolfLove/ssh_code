package store

import (
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

func TestSaveAndList(t *testing.T) {
	s := newTestStore(t)

	summary, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if summary.DisplayName != "root@example.com" {
		t.Fatalf("DisplayName = %q, want %q", summary.DisplayName, "root@example.com")
	}
	if summary.ID == "" {
		t.Fatal("expected a non-empty ID")
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List returned %d entries, want 1", len(list))
	}
	if list[0].ID != summary.ID {
		t.Fatalf("List()[0].ID = %q, want %q", list[0].ID, summary.ID)
	}
}

func TestSaveUpsertsByHostPortUsername(t *testing.T) {
	s := newTestStore(t)

	first, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save (first): %v", err)
	}

	second, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "different"})
	if err != nil {
		t.Fatalf("Save (second): %v", err)
	}

	if first.ID != second.ID {
		t.Fatalf("expected the same (host,port,username) to produce the same id: %q vs %q", first.ID, second.ID)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List returned %d entries after upsert, want 1", len(list))
	}
}

func TestSavePreservesDisplayNameAndWorkspacePathsAcrossUpsert(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"}); err != nil {
		t.Fatalf("Save (first): %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	id := list[0].ID

	if err := s.Rename(id, "My Server"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if err := s.UpdateWorkspacePath(id, "/home/root/project"); err != nil {
		t.Fatalf("UpdateWorkspacePath: %v", err)
	}

	if _, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"}); err != nil {
		t.Fatalf("Save (second): %v", err)
	}

	list, err = s.List()
	if err != nil {
		t.Fatalf("List (after re-save): %v", err)
	}
	if list[0].DisplayName != "My Server" {
		t.Fatalf("DisplayName after re-save = %q, want %q (should be preserved)", list[0].DisplayName, "My Server")
	}
	if list[0].LastWorkspacePath != "/home/root/project" {
		t.Fatalf("LastWorkspacePath after re-save = %q, want %q (should be preserved)", list[0].LastWorkspacePath, "/home/root/project")
	}
}

func TestGetConnectInputRoundTripsSecrets(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.Save(ConnectInput{
		Host:     "example.com",
		Port:     22,
		Username: "root",
		Password: "hunter2",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	id := s.GetConnectionID("example.com", 22, "root")
	input, err := s.GetConnectInput(id)
	if err != nil {
		t.Fatalf("GetConnectInput: %v", err)
	}

	if input.Password != "hunter2" {
		t.Fatalf("Password = %q, want %q", input.Password, "hunter2")
	}
	if input.Host != "example.com" || input.Port != 22 || input.Username != "root" {
		t.Fatalf("unexpected round-tripped identity fields: %+v", input)
	}
}

func TestGetConnectInputPrivateKeyRoundTripsPassphrase(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.Save(ConnectInput{
		Host:           "example.com",
		Port:           22,
		Username:       "root",
		AuthMethod:     "privateKey",
		PrivateKeyPath: "/home/root/.ssh/id_ed25519",
		Passphrase:     "correct-horse-battery-staple",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	id := s.GetConnectionID("example.com", 22, "root")
	input, err := s.GetConnectInput(id)
	if err != nil {
		t.Fatalf("GetConnectInput: %v", err)
	}

	if input.Passphrase != "correct-horse-battery-staple" {
		t.Fatalf("Passphrase = %q, want %q", input.Passphrase, "correct-horse-battery-staple")
	}
	if input.PrivateKeyPath != "/home/root/.ssh/id_ed25519" {
		t.Fatalf("PrivateKeyPath = %q, want the saved path", input.PrivateKeyPath)
	}
	// Password auth-only fields should not leak across auth methods.
	if input.Password != "" {
		t.Fatalf("Password = %q, want empty for privateKey auth", input.Password)
	}
}

func TestGetConnectInputJumpHostRoundTrips(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.Save(ConnectInput{
		Host:     "target.example.com",
		Port:     22,
		Username: "root",
		Password: "hunter2",
		JumpHost: &JumpHostInput{
			Host:       "bastion.example.com",
			Port:       22,
			Username:   "jump",
			AuthMethod: "password",
			Password:   "jumpsecret",
		},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	id := s.GetConnectionID("target.example.com", 22, "root")
	input, err := s.GetConnectInput(id)
	if err != nil {
		t.Fatalf("GetConnectInput: %v", err)
	}

	if input.JumpHost == nil {
		t.Fatal("expected a non-nil JumpHost")
	}
	if input.JumpHost.Password != "jumpsecret" {
		t.Fatalf("JumpHost.Password = %q, want %q", input.JumpHost.Password, "jumpsecret")
	}
	if input.JumpHost.Host != "bastion.example.com" {
		t.Fatalf("JumpHost.Host = %q, want %q", input.JumpHost.Host, "bastion.example.com")
	}
}

func TestGetConnectInputNotFound(t *testing.T) {
	s := newTestStore(t)

	if _, err := s.GetConnectInput("does-not-exist"); err == nil {
		t.Fatal("expected an error for an unknown saved connection id")
	}
}

func TestRemove(t *testing.T) {
	s := newTestStore(t)

	summary, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := s.Remove(summary.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("List returned %d entries after Remove, want 0", len(list))
	}
}

func TestRename(t *testing.T) {
	s := newTestStore(t)

	summary, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := s.Rename(summary.ID, "  Production Box  "); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if list[0].DisplayName != "Production Box" {
		t.Fatalf("DisplayName = %q, want trimmed %q", list[0].DisplayName, "Production Box")
	}
}

func TestRenameBlankIsNoOp(t *testing.T) {
	s := newTestStore(t)

	summary, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := s.Rename(summary.ID, "   "); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if list[0].DisplayName != "root@example.com" {
		t.Fatalf("DisplayName changed after a blank rename: %q", list[0].DisplayName)
	}
}

func TestUpdateWorkspacePathDedupsAndCapsAtSix(t *testing.T) {
	s := newTestStore(t)

	summary, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	paths := []string{"/a", "/b", "/c", "/d", "/e", "/f", "/g"}
	for _, p := range paths {
		if err := s.UpdateWorkspacePath(summary.ID, p); err != nil {
			t.Fatalf("UpdateWorkspacePath(%q): %v", p, err)
		}
	}
	// Re-add an earlier path; it should move to the front, not duplicate.
	if err := s.UpdateWorkspacePath(summary.ID, "/c"); err != nil {
		t.Fatalf("UpdateWorkspacePath(/c again): %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}

	if len(list[0].WorkspacePaths) != MaxWorkspacePaths {
		t.Fatalf("WorkspacePaths length = %d, want %d", len(list[0].WorkspacePaths), MaxWorkspacePaths)
	}
	if list[0].LastWorkspacePath != "/c" {
		t.Fatalf("LastWorkspacePath = %q, want %q (most recently used)", list[0].LastWorkspacePath, "/c")
	}

	seen := make(map[string]bool)
	for _, p := range list[0].WorkspacePaths {
		if seen[p] {
			t.Fatalf("WorkspacePaths contains a duplicate: %q", p)
		}
		seen[p] = true
	}
}

func TestMaxSavedConnectionsTruncation(t *testing.T) {
	s := newTestStore(t)

	for i := 0; i < MaxSavedConnections+3; i++ {
		host := "host" + string(rune('a'+i)) + ".example.com"
		if _, err := s.Save(ConnectInput{Host: host, Port: 22, Username: "root", Password: "x"}); err != nil {
			t.Fatalf("Save(%s): %v", host, err)
		}
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != MaxSavedConnections {
		t.Fatalf("List returned %d entries, want the cap of %d", len(list), MaxSavedConnections)
	}
}

func TestTunnelsFieldRoundTripsThroughJSON(t *testing.T) {
	s := newTestStore(t)

	summary, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "hunter2"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Simulate a Phase 3 write of a tunnel config by round-tripping
	// arbitrary JSON through the store's Tunnels field directly, confirming
	// the file format has a place for it even though Phase 2 doesn't
	// validate or manipulate tunnel configs itself.
	data, err := s.readDataLocked()
	if err != nil {
		t.Fatalf("readDataLocked: %v", err)
	}
	for i := range data.Connections {
		if data.Connections[i].ID == summary.ID {
			data.Connections[i].Tunnels = []SavedTunnelConfig{{
				ID:         "t1",
				Name:       "web",
				Kind:       TunnelKindLocal,
				LocalHost:  "127.0.0.1",
				LocalPort:  8080,
				TargetHost: "127.0.0.1",
				TargetPort: 80,
			}}
		}
	}
	if err := s.writeDataLocked(data); err != nil {
		t.Fatalf("writeDataLocked: %v", err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list[0].Tunnels) != 1 {
		t.Fatalf("Tunnels length = %d, want 1", len(list[0].Tunnels))
	}
}
