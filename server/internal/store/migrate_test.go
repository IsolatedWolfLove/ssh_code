package store

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeLegacyFile(t *testing.T, dir string, legacy legacyDataFile) {
	t.Helper()
	raw, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("marshal legacy fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, connectionsFileName), raw, 0o600); err != nil {
		t.Fatalf("write legacy fixture: %v", err)
	}
}

func TestMigrateFromElectronNoLegacyFileIsNoOp(t *testing.T) {
	s := newTestStore(t)
	legacyDir := t.TempDir() // empty, no saved-connections.json inside

	result, err := s.MigrateFromElectron(legacyDir)
	if err != nil {
		t.Fatalf("MigrateFromElectron: %v", err)
	}
	if result.Migrated != 0 || result.NeedsReentry != 0 {
		t.Fatalf("expected a no-op result, got %+v", result)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("List returned %d entries after a no-op migration, want 0", len(list))
	}
}

func TestMigrateFromElectronPlainSecretMigratesLosslessly(t *testing.T) {
	s := newTestStore(t)
	legacyDir := t.TempDir()

	plainPassword := base64.StdEncoding.EncodeToString([]byte("hunter2"))
	writeLegacyFile(t, legacyDir, legacyDataFile{
		Version: 1,
		Connections: []legacyStoredConnection{
			{
				ID:               "abc123",
				Host:             "example.com",
				Port:             22,
				Username:         "root",
				AuthMethod:       "password",
				Password:         plainPassword,
				PasswordEncoding: "plain",
				LastConnectedAt:  "2024-01-01T00:00:00.000Z",
			},
		},
	})

	result, err := s.MigrateFromElectron(legacyDir)
	if err != nil {
		t.Fatalf("MigrateFromElectron: %v", err)
	}
	if result.Migrated != 1 {
		t.Fatalf("Migrated = %d, want 1", result.Migrated)
	}
	if result.NeedsReentry != 0 {
		t.Fatalf("NeedsReentry = %d, want 0 for a 'plain'-encoded secret", result.NeedsReentry)
	}

	input, err := s.GetConnectInput("abc123")
	if err != nil {
		t.Fatalf("GetConnectInput: %v", err)
	}
	if input.Password != "hunter2" {
		t.Fatalf("Password = %q, want %q (lossless migration)", input.Password, "hunter2")
	}

	// Confirm it was re-encrypted with the new scheme, not left as 'plain'.
	data, err := s.readDataLocked()
	if err != nil {
		t.Fatalf("readDataLocked: %v", err)
	}
	if data.Connections[0].PasswordEncoding != EncodingAESGCM {
		t.Fatalf("PasswordEncoding after migration = %q, want %q", data.Connections[0].PasswordEncoding, EncodingAESGCM)
	}
}

func TestMigrateFromElectronSafeStorageSecretDropsAndFlagsReentry(t *testing.T) {
	s := newTestStore(t)
	legacyDir := t.TempDir()

	writeLegacyFile(t, legacyDir, legacyDataFile{
		Version: 1,
		Connections: []legacyStoredConnection{
			{
				ID:               "def456",
				Host:             "prod.example.com",
				Port:             22,
				Username:         "deploy",
				AuthMethod:       "password",
				Password:         "opaque-os-encrypted-blob-not-decryptable-by-go",
				PasswordEncoding: "safeStorage",
				PrivateKeyPath:   "",
				LastConnectedAt:  "2024-01-01T00:00:00.000Z",
			},
		},
	})

	result, err := s.MigrateFromElectron(legacyDir)
	if err != nil {
		t.Fatalf("MigrateFromElectron: %v", err)
	}
	if result.Migrated != 1 {
		t.Fatalf("Migrated = %d, want 1", result.Migrated)
	}
	if result.NeedsReentry != 1 {
		t.Fatalf("NeedsReentry = %d, want 1 for a 'safeStorage'-encoded secret", result.NeedsReentry)
	}

	input, err := s.GetConnectInput("def456")
	if err != nil {
		t.Fatalf("GetConnectInput: %v", err)
	}
	if input.Password != "" {
		t.Fatalf("Password = %q, want empty (safeStorage secrets cannot be decrypted by Go)", input.Password)
	}
	// Identity fields must still survive even though the secret was dropped.
	if input.Host != "prod.example.com" || input.Username != "deploy" {
		t.Fatalf("identity fields lost during migration: %+v", input)
	}

	data, err := s.readDataLocked()
	if err != nil {
		t.Fatalf("readDataLocked: %v", err)
	}
	if data.Connections[0].PasswordEncoding != EncodingNone {
		t.Fatalf("PasswordEncoding after migration = %q, want %q", data.Connections[0].PasswordEncoding, EncodingNone)
	}
}

func TestMigrateFromElectronRunsOnlyOnce(t *testing.T) {
	s := newTestStore(t)
	legacyDir := t.TempDir()

	writeLegacyFile(t, legacyDir, legacyDataFile{
		Version: 1,
		Connections: []legacyStoredConnection{
			{
				ID:               "abc123",
				Host:             "example.com",
				Port:             22,
				Username:         "root",
				PasswordEncoding: "none",
				LastConnectedAt:  "2024-01-01T00:00:00.000Z",
			},
		},
	})

	first, err := s.MigrateFromElectron(legacyDir)
	if err != nil {
		t.Fatalf("MigrateFromElectron (first): %v", err)
	}
	if first.Migrated != 1 {
		t.Fatalf("first Migrated = %d, want 1", first.Migrated)
	}

	// Remove the connection to prove a second migration call does not
	// re-import it (marker file should gate re-runs).
	if err := s.Remove("abc123"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	second, err := s.MigrateFromElectron(legacyDir)
	if err != nil {
		t.Fatalf("MigrateFromElectron (second): %v", err)
	}
	if second.Migrated != 0 {
		t.Fatalf("second Migrated = %d, want 0 (already migrated, gated by marker file)", second.Migrated)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("List returned %d entries; the removed connection should not have been re-imported", len(list))
	}
}

func TestMigrateFromElectronSkipsExistingID(t *testing.T) {
	s := newTestStore(t)
	legacyDir := t.TempDir()

	// A connection already exists under this app (e.g. the user connected
	// once before migration ran).
	saved, err := s.Save(ConnectInput{Host: "example.com", Port: 22, Username: "root", Password: "new-password"})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	writeLegacyFile(t, legacyDir, legacyDataFile{
		Version: 1,
		Connections: []legacyStoredConnection{
			{
				ID:               saved.ID,
				Host:             "example.com",
				Port:             22,
				Username:         "root",
				Password:         base64.StdEncoding.EncodeToString([]byte("old-password")),
				PasswordEncoding: "plain",
				LastConnectedAt:  "2020-01-01T00:00:00.000Z",
			},
		},
	})

	result, err := s.MigrateFromElectron(legacyDir)
	if err != nil {
		t.Fatalf("MigrateFromElectron: %v", err)
	}
	if result.Migrated != 0 {
		t.Fatalf("Migrated = %d, want 0 (id already present, should not overwrite)", result.Migrated)
	}

	input, err := s.GetConnectInput(saved.ID)
	if err != nil {
		t.Fatalf("GetConnectInput: %v", err)
	}
	if input.Password != "new-password" {
		t.Fatalf("Password = %q, want the newer entry's password %q (not overwritten by migration)", input.Password, "new-password")
	}
}
