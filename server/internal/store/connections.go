package store

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// MaxSavedConnections mirrors MAX_SAVED_CONNECTIONS in saved-connections.ts.
const MaxSavedConnections = 12

// MaxWorkspacePaths mirrors MAX_WORKSPACE_PATHS in saved-connections.ts.
const MaxWorkspacePaths = 6

const connectionsFileName = "saved-connections.json"
const storedFileVersion = 1

// SecretEncoding mirrors the {password, passwordEncoding} pairing in
// saved-connections.ts, extended with "aesgcm" for the Wails backend's own
// scheme. "safeStorage" only ever appears in data migrated from (or read
// directly out of) the legacy Electron store; this process cannot decrypt
// it - see migrate.go.
type SecretEncoding string

const (
	EncodingAESGCM      SecretEncoding = "aesgcm"
	EncodingPlain       SecretEncoding = "plain"
	EncodingSafeStorage SecretEncoding = "safeStorage"
	EncodingNone        SecretEncoding = "none"
)

// JumpHostInput mirrors contracts.ts's JumpHostInput (the app package has its
// own copy for its Wails bindings; this one exists so the store package has
// no dependency on app, matching the pattern already used by internal/ssh).
type JumpHostInput struct {
	Host           string
	Port           int
	Username       string
	AuthMethod     string
	Password       string
	PrivateKeyPath string
	Passphrase     string
	AgentSocket    string
}

// ConnectInput mirrors contracts.ts's ConnectInput.
type ConnectInput struct {
	Host             string
	Port             int
	Username         string
	AuthMethod       string
	Password         string
	PrivateKeyPath   string
	Passphrase       string
	AgentSocket      string
	HostVerification string
	KnownHostsPath   string
	JumpHost         *JumpHostInput
}

// SavedConnectionSummary mirrors contracts.ts's SavedConnectionSummary.
type SavedConnectionSummary struct {
	ID                string
	DisplayName       string
	Host              string
	Port              int
	Username          string
	AuthMethod        string
	LastConnectedAt   string
	LastWorkspacePath string
	WorkspacePaths    []string
	// Tunnels is this connection's saved tunnel configs (see tunnels.go for
	// SavedTunnelConfig and the validation/dedup logic ported from
	// saved-connections.ts's normalizeTunnels/normalizeTunnelConfig).
	Tunnels []SavedTunnelConfig
}

// StoredJumpHost is the on-disk shape of a saved jump-host hop, mirroring
// StoredJumpHost in saved-connections.ts.
type StoredJumpHost struct {
	Host               string         `json:"host"`
	Port               int            `json:"port"`
	Username           string         `json:"username"`
	AuthMethod         string         `json:"authMethod"`
	Password           string         `json:"password"`
	PasswordEncoding   SecretEncoding `json:"passwordEncoding"`
	PrivateKeyPath     string         `json:"privateKeyPath,omitempty"`
	Passphrase         string         `json:"passphrase,omitempty"`
	PassphraseEncoding SecretEncoding `json:"passphraseEncoding,omitempty"`
	AgentSocket        string         `json:"agentSocket,omitempty"`
}

// StoredConnection is the on-disk shape of one saved connection, mirroring
// StoredSavedConnection in saved-connections.ts.
type StoredConnection struct {
	ID                 string              `json:"id"`
	DisplayName        string              `json:"displayName,omitempty"`
	Host               string              `json:"host"`
	Port               int                 `json:"port"`
	Username           string              `json:"username"`
	AuthMethod         string              `json:"authMethod,omitempty"`
	Password           string              `json:"password"`
	PasswordEncoding   SecretEncoding      `json:"passwordEncoding"`
	PrivateKeyPath     string              `json:"privateKeyPath,omitempty"`
	Passphrase         string              `json:"passphrase,omitempty"`
	PassphraseEncoding SecretEncoding      `json:"passphraseEncoding,omitempty"`
	AgentSocket        string              `json:"agentSocket,omitempty"`
	HostVerification   string              `json:"hostVerification,omitempty"`
	KnownHostsPath     string              `json:"knownHostsPath,omitempty"`
	JumpHost           *StoredJumpHost     `json:"jumpHost,omitempty"`
	LastConnectedAt    string              `json:"lastConnectedAt"`
	LastWorkspacePath  string              `json:"lastWorkspacePath,omitempty"`
	WorkspacePaths     []string            `json:"workspacePaths,omitempty"`
	Tunnels            []SavedTunnelConfig `json:"tunnels,omitempty"`
}

type dataFile struct {
	Version     int                `json:"version"`
	Connections []StoredConnection `json:"connections"`
}

// Store persists saved connections to <dir>/saved-connections.json,
// encrypting secrets with a key file also kept in dir. All mutations are
// serialized by mu, replacing saved-connections.ts's promise-chain
// mutationQueue with a plain mutex (Go has no single-threaded event loop to
// rely on instead).
type Store struct {
	mu       sync.Mutex
	filePath string
	key      []byte
}

// NewStore creates dir if needed and opens (or initializes) the store inside
// it, including its encryption key file.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("unable to create store directory: %w", err)
	}
	key, err := GenerateOrLoadKey(dir)
	if err != nil {
		return nil, err
	}
	return &Store{filePath: filepath.Join(dir, connectionsFileName), key: key}, nil
}

// GetConnectionID mirrors SavedConnectionStore.getConnectionId: computes the
// stable ID a (host, port, username) triple maps to, without needing an
// existing stored entry. Callers use this to know a connection's id before
// it has necessarily been saved (e.g. app.go's Connect wires this up before
// dialing, matching src/main/index.ts's ordering).
func (s *Store) GetConnectionID(host string, port int, username string) string {
	return buildSavedConnectionID(host, port, username)
}

// List mirrors listSummaries: every saved connection, most recently
// connected first.
func (s *Store) List() ([]SavedConnectionSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return nil, err
	}

	sortByRecentUse(data.Connections)

	out := make([]SavedConnectionSummary, 0, len(data.Connections))
	for _, connection := range data.Connections {
		out = append(out, s.summarize(connection))
	}
	return out, nil
}

// GetConnectInput mirrors getConnectInput: looks up a saved connection by id
// and decrypts its secrets back into a ConnectInput ready to hand to
// internal/ssh.Manager.Connect.
func (s *Store) GetConnectInput(savedConnectionID string) (ConnectInput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return ConnectInput{}, err
	}

	for _, connection := range data.Connections {
		if connection.ID == savedConnectionID {
			return s.toConnectInput(connection), nil
		}
	}

	return ConnectInput{}, fmt.Errorf("saved connection not found")
}

// Save mirrors saveConnection: upserts by (host, port, username)-derived id,
// preserving the previous entry's displayName/workspacePaths/tunnels,
// bumping lastConnectedAt to now, then re-sorts and truncates to
// MaxSavedConnections.
func (s *Store) Save(input ConnectInput) (SavedConnectionSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return SavedConnectionSummary{}, err
	}

	id := buildSavedConnectionID(input.Host, input.Port, input.Username)
	var previous *StoredConnection
	for i := range data.Connections {
		if data.Connections[i].ID == id {
			previous = &data.Connections[i]
			break
		}
	}

	next, err := s.createStoredConnection(input, previous)
	if err != nil {
		return SavedConnectionSummary{}, err
	}

	merged := make([]StoredConnection, 0, len(data.Connections)+1)
	merged = append(merged, next)
	for _, connection := range data.Connections {
		if connection.ID != next.ID {
			merged = append(merged, connection)
		}
	}
	sortByRecentUse(merged)
	if len(merged) > MaxSavedConnections {
		merged = merged[:MaxSavedConnections]
	}

	data.Connections = merged
	if err := s.writeDataLocked(data); err != nil {
		return SavedConnectionSummary{}, err
	}

	return s.summarize(next), nil
}

// Remove mirrors removeConnection.
func (s *Store) Remove(savedConnectionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return err
	}

	next := make([]StoredConnection, 0, len(data.Connections))
	for _, connection := range data.Connections {
		if connection.ID != savedConnectionID {
			next = append(next, connection)
		}
	}
	if len(next) == len(data.Connections) {
		return nil
	}

	data.Connections = next
	return s.writeDataLocked(data)
}

// Rename mirrors renameConnection.
func (s *Store) Rename(savedConnectionID string, displayName string) error {
	trimmed := strings.TrimSpace(displayName)
	if trimmed == "" {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return err
	}

	changed := false
	for i := range data.Connections {
		if data.Connections[i].ID == savedConnectionID {
			data.Connections[i].DisplayName = trimmed
			changed = true
		}
	}
	if !changed {
		return nil
	}

	return s.writeDataLocked(data)
}

// UpdateWorkspacePath mirrors updateWorkspacePath: prepends workspacePath to
// the connection's known workspace paths (most-recent-first), deduping and
// capping at MaxWorkspacePaths.
func (s *Store) UpdateWorkspacePath(savedConnectionID string, workspacePath string) error {
	trimmed := strings.TrimSpace(workspacePath)
	if trimmed == "" {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := s.readDataLocked()
	if err != nil {
		return err
	}

	changed := false
	for i := range data.Connections {
		if data.Connections[i].ID != savedConnectionID {
			continue
		}

		nextPaths := normalizeWorkspacePaths(append([]string{trimmed}, getWorkspacePaths(data.Connections[i])...))
		data.Connections[i].WorkspacePaths = nextPaths
		if len(nextPaths) > 0 {
			data.Connections[i].LastWorkspacePath = nextPaths[0]
		}
		changed = true
	}
	if !changed {
		return nil
	}

	return s.writeDataLocked(data)
}

// --- persistence -------------------------------------------------------------

func (s *Store) readDataLocked() (dataFile, error) {
	empty := dataFile{Version: storedFileVersion, Connections: []StoredConnection{}}

	raw, err := os.ReadFile(s.filePath)
	if err != nil {
		// Mirrors readData in saved-connections.ts: a missing or unreadable
		// file degrades to an empty store rather than surfacing an error - a
		// corrupt file must not brick the app.
		return empty, nil
	}

	var parsed dataFile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return empty, nil
	}
	if parsed.Version != storedFileVersion {
		return empty, nil
	}
	if parsed.Connections == nil {
		parsed.Connections = []StoredConnection{}
	}
	return parsed, nil
}

func (s *Store) writeDataLocked(data dataFile) error {
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0o755); err != nil {
		return err
	}

	data.Version = storedFileVersion
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}

	// 0600 rather than saved-connections.ts's default file mode: the file
	// contains encrypted secrets, and there's no reason to make it
	// world/group-readable even though the ciphertext itself is opaque
	// without the sibling key file.
	return os.WriteFile(s.filePath, raw, 0o600)
}

// --- conversions --------------------------------------------------------------

func (s *Store) createStoredConnection(input ConnectInput, previous *StoredConnection) (StoredConnection, error) {
	host := strings.TrimSpace(input.Host)
	username := strings.TrimSpace(input.Username)
	authMethod := orDefault(input.AuthMethod, "password")

	passwordValue, passwordEncoding, err := s.protectOptionalSecret(onlyIf(authMethod == "password", input.Password))
	if err != nil {
		return StoredConnection{}, err
	}
	passphraseValue, passphraseEncoding, err := s.protectOptionalSecret(onlyIf(authMethod == "privateKey", input.Passphrase))
	if err != nil {
		return StoredConnection{}, err
	}

	displayName := defaultDisplayName(host, username)
	var workspacePaths []string
	var tunnels []SavedTunnelConfig
	if previous != nil {
		workspacePaths = getWorkspacePaths(*previous)
		tunnels = previous.Tunnels
		if strings.TrimSpace(previous.DisplayName) != "" {
			displayName = previous.DisplayName
		}
	}

	jumpHost, err := s.createStoredJumpHost(input.JumpHost)
	if err != nil {
		return StoredConnection{}, err
	}

	lastWorkspacePath := ""
	if len(workspacePaths) > 0 {
		lastWorkspacePath = workspacePaths[0]
	}

	return StoredConnection{
		ID:                 buildSavedConnectionID(host, input.Port, username),
		DisplayName:        displayName,
		Host:               host,
		Port:               input.Port,
		Username:           username,
		AuthMethod:         authMethod,
		Password:           passwordValue,
		PasswordEncoding:   passwordEncoding,
		PrivateKeyPath:     onlyIf(authMethod == "privateKey", strings.TrimSpace(input.PrivateKeyPath)),
		Passphrase:         passphraseValue,
		PassphraseEncoding: passphraseEncoding,
		AgentSocket:        onlyIf(authMethod == "agent", strings.TrimSpace(input.AgentSocket)),
		HostVerification:   orDefault(input.HostVerification, "off"),
		KnownHostsPath:     strings.TrimSpace(input.KnownHostsPath),
		JumpHost:           jumpHost,
		LastConnectedAt:    time.Now().UTC().Format(time.RFC3339),
		LastWorkspacePath:  lastWorkspacePath,
		WorkspacePaths:     workspacePaths,
		Tunnels:            tunnels,
	}, nil
}

func (s *Store) createStoredJumpHost(input *JumpHostInput) (*StoredJumpHost, error) {
	if input == nil {
		return nil, nil
	}

	host := strings.TrimSpace(input.Host)
	username := strings.TrimSpace(input.Username)
	if host == "" || username == "" || !isValidPort(input.Port) {
		return nil, nil
	}

	passwordValue, passwordEncoding, err := s.protectOptionalSecret(onlyIf(input.AuthMethod == "password", input.Password))
	if err != nil {
		return nil, err
	}
	passphraseValue, passphraseEncoding, err := s.protectOptionalSecret(onlyIf(input.AuthMethod == "privateKey", input.Passphrase))
	if err != nil {
		return nil, err
	}

	return &StoredJumpHost{
		Host:               host,
		Port:               input.Port,
		Username:           username,
		AuthMethod:         input.AuthMethod,
		Password:           passwordValue,
		PasswordEncoding:   passwordEncoding,
		PrivateKeyPath:     onlyIf(input.AuthMethod == "privateKey", strings.TrimSpace(input.PrivateKeyPath)),
		Passphrase:         passphraseValue,
		PassphraseEncoding: passphraseEncoding,
		AgentSocket:        onlyIf(input.AuthMethod == "agent", strings.TrimSpace(input.AgentSocket)),
	}, nil
}

func (s *Store) toConnectInput(c StoredConnection) ConnectInput {
	result := ConnectInput{
		Host:             c.Host,
		Port:             c.Port,
		Username:         c.Username,
		AuthMethod:       orDefault(c.AuthMethod, "password"),
		Password:         s.unprotectOptionalSecret(c.Password, c.PasswordEncoding),
		PrivateKeyPath:   c.PrivateKeyPath,
		Passphrase:       s.unprotectOptionalSecret(c.Passphrase, c.PassphraseEncoding),
		AgentSocket:      c.AgentSocket,
		HostVerification: orDefault(c.HostVerification, "off"),
		KnownHostsPath:   c.KnownHostsPath,
	}

	if c.JumpHost != nil {
		result.JumpHost = &JumpHostInput{
			Host:           c.JumpHost.Host,
			Port:           c.JumpHost.Port,
			Username:       c.JumpHost.Username,
			AuthMethod:     c.JumpHost.AuthMethod,
			Password:       s.unprotectOptionalSecret(c.JumpHost.Password, c.JumpHost.PasswordEncoding),
			PrivateKeyPath: c.JumpHost.PrivateKeyPath,
			Passphrase:     s.unprotectOptionalSecret(c.JumpHost.Passphrase, c.JumpHost.PassphraseEncoding),
			AgentSocket:    c.JumpHost.AgentSocket,
		}
	}

	return result
}

func (s *Store) summarize(c StoredConnection) SavedConnectionSummary {
	paths := getWorkspacePaths(c)
	lastWorkspacePath := ""
	if len(paths) > 0 {
		lastWorkspacePath = paths[0]
	}

	return SavedConnectionSummary{
		ID:                c.ID,
		DisplayName:       displayNameOrDefault(c.DisplayName, c.Host, c.Username),
		Host:              c.Host,
		Port:              c.Port,
		Username:          c.Username,
		AuthMethod:        orDefault(c.AuthMethod, "password"),
		LastConnectedAt:   c.LastConnectedAt,
		LastWorkspacePath: lastWorkspacePath,
		WorkspacePaths:    paths,
		Tunnels:           append([]SavedTunnelConfig{}, c.Tunnels...),
	}
}

// --- secret protection ---------------------------------------------------

func (s *Store) protectOptionalSecret(secret string) (string, SecretEncoding, error) {
	if secret == "" {
		return "", EncodingNone, nil
	}

	encrypted, err := Encrypt(s.key, secret)
	if err != nil {
		return "", "", err
	}
	return encrypted, EncodingAESGCM, nil
}

func (s *Store) unprotectOptionalSecret(value string, encoding SecretEncoding) string {
	if encoding == EncodingNone || value == "" {
		return ""
	}

	switch encoding {
	case EncodingAESGCM:
		plaintext, err := Decrypt(s.key, value)
		if err != nil {
			return ""
		}
		return plaintext
	case EncodingPlain:
		raw, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return ""
		}
		return string(raw)
	default:
		// EncodingSafeStorage (or anything unrecognized): this process
		// cannot decrypt Electron's safeStorage-protected values (they are
		// tied to an OS-level keychain entry scoped to that specific
		// binary). migrate.go is expected to convert these to 'none' with
		// an empty value during migration; this branch is a defensive
		// fallback in case an entry somehow bypasses migration (e.g. a
		// value hand-edited into the store file).
		return ""
	}
}

// --- helpers ---------------------------------------------------------------

func buildSavedConnectionID(host string, port int, username string) string {
	// Mirrors buildSavedConnectionId in saved-connections.ts exactly:
	// sha256(JSON.stringify([host.trim(), port, username.trim()])), hex,
	// sliced to 24 chars. Go's encoding/json marshals a []interface{} of
	// (string, int, string) with the same byte-for-byte output as
	// JSON.stringify for these types, so IDs computed here match IDs the
	// old Electron app would have computed for the same triple.
	payload, _ := json.Marshal([]interface{}{strings.TrimSpace(host), port, strings.TrimSpace(username)})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])[:24]
}

func sortByRecentUse(connections []StoredConnection) {
	sort.SliceStable(connections, func(i, j int) bool {
		return connections[i].LastConnectedAt > connections[j].LastConnectedAt
	})
}

func normalizeWorkspacePaths(paths []string) []string {
	seen := make(map[string]bool, len(paths))
	result := make([]string, 0, len(paths))
	for _, raw := range paths {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
		if len(result) >= MaxWorkspacePaths {
			break
		}
	}
	return result
}

func getWorkspacePaths(c StoredConnection) []string {
	combined := make([]string, 0, len(c.WorkspacePaths)+1)
	combined = append(combined, c.WorkspacePaths...)
	if c.LastWorkspacePath != "" {
		combined = append(combined, c.LastWorkspacePath)
	}
	return normalizeWorkspacePaths(combined)
}

func defaultDisplayName(host, username string) string {
	return fmt.Sprintf("%s@%s", username, host)
}

func displayNameOrDefault(displayName, host, username string) string {
	trimmed := strings.TrimSpace(displayName)
	if trimmed != "" {
		return trimmed
	}
	return defaultDisplayName(host, username)
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func onlyIf(cond bool, value string) string {
	if cond {
		return value
	}
	return ""
}

func isValidPort(port int) bool {
	return port >= 1 && port <= 65535
}
