package store

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// migrationMarkerFileName gates MigrateFromElectron to run at most once per
// store directory.
const migrationMarkerFileName = "migrated-from-electron"

// MigrationResult reports what MigrateFromElectron did, so callers (app.go)
// can surface it to the user later even though Phase 2 does not build any UI
// for it yet.
type MigrationResult struct {
	// Migrated is how many saved connections were imported at all (lossless
	// or not).
	Migrated int
	// NeedsReentry is how many of those had a 'safeStorage'-encoded secret
	// that could not be decrypted and was dropped; the user must re-enter
	// that connection's password/passphrase once.
	NeedsReentry int
}

// legacyStoredJumpHost/legacyStoredConnection/legacyDataFile mirror the
// on-disk shape written by Electron's saved-connections.ts (StoredJumpHost /
// StoredSavedConnection / SavedConnectionsFile), independently of this
// package's own StoredConnection - the two are similar but not identical,
// and keeping the legacy read path separate makes clear this is a one-time,
// read-only import rather than an ongoing dependency.
type legacyStoredJumpHost struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Username           string `json:"username"`
	AuthMethod         string `json:"authMethod"`
	Password           string `json:"password"`
	PasswordEncoding   string `json:"passwordEncoding"`
	PrivateKeyPath     string `json:"privateKeyPath,omitempty"`
	Passphrase         string `json:"passphrase,omitempty"`
	PassphraseEncoding string `json:"passphraseEncoding,omitempty"`
	AgentSocket        string `json:"agentSocket,omitempty"`
}

type legacyStoredConnection struct {
	ID                 string                `json:"id"`
	DisplayName        string                `json:"displayName,omitempty"`
	Host               string                `json:"host"`
	Port               int                   `json:"port"`
	Username           string                `json:"username"`
	AuthMethod         string                `json:"authMethod,omitempty"`
	Password           string                `json:"password"`
	PasswordEncoding   string                `json:"passwordEncoding"`
	PrivateKeyPath     string                `json:"privateKeyPath,omitempty"`
	Passphrase         string                `json:"passphrase,omitempty"`
	PassphraseEncoding string                `json:"passphraseEncoding,omitempty"`
	AgentSocket        string                `json:"agentSocket,omitempty"`
	HostVerification   string                `json:"hostVerification,omitempty"`
	KnownHostsPath     string                `json:"knownHostsPath,omitempty"`
	JumpHost           *legacyStoredJumpHost `json:"jumpHost,omitempty"`
	LastConnectedAt    string                `json:"lastConnectedAt"`
	LastWorkspacePath  string                `json:"lastWorkspacePath,omitempty"`
	WorkspacePaths     []string              `json:"workspacePaths,omitempty"`
	Tunnels            []json.RawMessage     `json:"tunnels,omitempty"`
}

type legacyDataFile struct {
	Version     int                      `json:"version"`
	Connections []legacyStoredConnection `json:"connections"`
}

// ElectronUserDataDir returns the directory Electron's app.getPath('userData')
// would resolve to on Linux for this app: ~/.config/<productName>, using the
// exact productName string from package.json ("SSH Studio"), unmodified
// (Electron does not lowercase or kebab-case the app name when building this
// path - it uses app.getName()'s value as-is).
//
// Confidence note: this is inferred from Electron's documented behavior
// (userData defaults to appData + app name, and productName takes
// precedence over the package.json "name" field per a long-standing
// Electron quirk - see electron/electron#8073) rather than verified by
// running the actual Electron app in this sandbox. If migration silently
// finds nothing in production where the real Electron app WAS run, this is
// the first thing to check.
func ElectronUserDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "SSH Studio"), nil
	case "windows":
		base, e := os.UserConfigDir()
		if e != nil {
			return "", e
		}
		return filepath.Join(base, "SSH Studio"), nil
	default:
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		return filepath.Join(base, "SSH Studio"), nil
	}
}

// MigrateFromElectron imports saved connections from the legacy Electron
// store (see ElectronUserDataDir) into s, exactly once. Subsequent calls
// (e.g. on every app startup) are no-ops once the marker file exists.
//
// 'plain'-encoded secrets migrate losslessly (base64-decode, re-encrypt with
// AES-GCM). 'safeStorage'-encoded secrets cannot be decrypted by this
// process - Electron's safeStorage ties encryption to an OS keychain entry
// scoped to that specific binary - so those are migrated with the secret
// dropped (encoding becomes 'none'); the returned NeedsReentry count tracks
// how many connections need the user to re-enter a password/passphrase.
func (s *Store) MigrateFromElectron(legacyDir string) (MigrationResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	markerPath := filepath.Join(filepath.Dir(s.filePath), migrationMarkerFileName)
	if _, err := os.Stat(markerPath); err == nil {
		return MigrationResult{}, nil // already migrated
	}

	legacyPath := filepath.Join(legacyDir, connectionsFileName)
	raw, err := os.ReadFile(legacyPath)
	if err != nil {
		if os.IsNotExist(err) {
			// No legacy install found - nothing to migrate. Do not write the
			// marker: if the user later runs the old Electron app and it
			// creates data, a subsequent launch of this app should still
			// pick it up rather than having permanently given up.
			return MigrationResult{}, nil
		}
		return MigrationResult{}, err
	}

	var legacy legacyDataFile
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return MigrationResult{}, err
	}

	data, err := s.readDataLocked()
	if err != nil {
		return MigrationResult{}, err
	}

	existingByID := make(map[string]bool, len(data.Connections))
	for _, connection := range data.Connections {
		existingByID[connection.ID] = true
	}

	result := MigrationResult{}
	for _, legacyConnection := range legacy.Connections {
		if existingByID[legacyConnection.ID] {
			// Already have a connection with this id (e.g. the user already
			// connected once under the new app before migration ran) - keep
			// the newer entry rather than overwriting it.
			continue
		}

		migrated, needsReentry, err := s.migrateLegacyConnection(legacyConnection)
		if err != nil {
			return result, err
		}

		data.Connections = append(data.Connections, migrated)
		existingByID[migrated.ID] = true
		result.Migrated++
		if needsReentry {
			result.NeedsReentry++
		}
	}

	if result.Migrated > 0 {
		sortByRecentUse(data.Connections)
		if len(data.Connections) > MaxSavedConnections {
			data.Connections = data.Connections[:MaxSavedConnections]
		}
		if err := s.writeDataLocked(data); err != nil {
			return result, err
		}
	}

	if err := os.WriteFile(markerPath, []byte(""), 0o600); err != nil {
		return result, err
	}

	return result, nil
}

func (s *Store) migrateLegacyConnection(legacy legacyStoredConnection) (StoredConnection, bool, error) {
	password, passwordEncoding, needsReentryPassword, err := s.migrateLegacySecret(legacy.Password, legacy.PasswordEncoding)
	if err != nil {
		return StoredConnection{}, false, err
	}
	passphrase, passphraseEncoding, needsReentryPassphrase, err := s.migrateLegacySecret(legacy.Passphrase, legacy.PassphraseEncoding)
	if err != nil {
		return StoredConnection{}, false, err
	}

	var jumpHost *StoredJumpHost
	needsReentryJump := false
	if legacy.JumpHost != nil {
		jumpPassword, jumpPasswordEncoding, needsReentryJumpPassword, err := s.migrateLegacySecret(legacy.JumpHost.Password, legacy.JumpHost.PasswordEncoding)
		if err != nil {
			return StoredConnection{}, false, err
		}
		jumpPassphrase, jumpPassphraseEncoding, needsReentryJumpPassphrase, err := s.migrateLegacySecret(legacy.JumpHost.Passphrase, legacy.JumpHost.PassphraseEncoding)
		if err != nil {
			return StoredConnection{}, false, err
		}
		needsReentryJump = needsReentryJumpPassword || needsReentryJumpPassphrase

		jumpHost = &StoredJumpHost{
			Host:               legacy.JumpHost.Host,
			Port:               legacy.JumpHost.Port,
			Username:           legacy.JumpHost.Username,
			AuthMethod:         legacy.JumpHost.AuthMethod,
			Password:           jumpPassword,
			PasswordEncoding:   jumpPasswordEncoding,
			PrivateKeyPath:     legacy.JumpHost.PrivateKeyPath,
			Passphrase:         jumpPassphrase,
			PassphraseEncoding: jumpPassphraseEncoding,
			AgentSocket:        legacy.JumpHost.AgentSocket,
		}
	}

	migrated := StoredConnection{
		ID:                 legacy.ID,
		DisplayName:        legacy.DisplayName,
		Host:               legacy.Host,
		Port:               legacy.Port,
		Username:           legacy.Username,
		AuthMethod:         legacy.AuthMethod,
		Password:           password,
		PasswordEncoding:   passwordEncoding,
		PrivateKeyPath:     legacy.PrivateKeyPath,
		Passphrase:         passphrase,
		PassphraseEncoding: passphraseEncoding,
		AgentSocket:        legacy.AgentSocket,
		HostVerification:   legacy.HostVerification,
		KnownHostsPath:     legacy.KnownHostsPath,
		JumpHost:           jumpHost,
		LastConnectedAt:    legacy.LastConnectedAt,
		LastWorkspacePath:  legacy.LastWorkspacePath,
		WorkspacePaths:     legacy.WorkspacePaths,
		Tunnels:            parseLegacyTunnels(legacy.Tunnels),
	}

	needsReentry := needsReentryPassword || needsReentryPassphrase || needsReentryJump
	return migrated, needsReentry, nil
}

// migrateLegacySecret converts one legacy {value, encoding} pair into the
// new store's scheme. Returns (value, encoding, needsReentry, error).
func (s *Store) migrateLegacySecret(value string, encoding string) (string, SecretEncoding, bool, error) {
	switch SecretEncoding(encoding) {
	case EncodingPlain:
		if value == "" {
			return "", EncodingNone, false, nil
		}
		raw, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			// Malformed legacy data: treat as unrecoverable rather than
			// failing the whole migration.
			return "", EncodingNone, true, nil
		}
		reencrypted, encoding, err := s.protectOptionalSecret(string(raw))
		if err != nil {
			return "", "", false, err
		}
		return reencrypted, encoding, false, nil

	case EncodingSafeStorage:
		if value == "" {
			return "", EncodingNone, false, nil
		}
		// Cannot decrypt: Electron's safeStorage is tied to an OS keychain
		// entry scoped to that specific binary. Drop the secret; the user
		// re-enters it once.
		return "", EncodingNone, true, nil

	default: // "none" or unrecognized
		return "", EncodingNone, false, nil
	}
}
