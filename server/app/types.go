package app

import "github.com/IsolatedWolfLove/ssh-studio-server/internal/store"

// Application wire types match src/shared/contracts.ts.
// JSON tags use the exact camelCase names from contracts.ts so the existing
// frontend TypeScript types (and JSON wire shape) don't need to change.

// JumpHostInput mirrors contracts.ts's JumpHostInput.
type JumpHostInput struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	AuthMethod     string `json:"authMethod"`
	Password       string `json:"password"`
	PrivateKeyPath string `json:"privateKeyPath,omitempty"`
	Passphrase     string `json:"passphrase,omitempty"`
	AgentSocket    string `json:"agentSocket,omitempty"`
}

// ConnectInput mirrors contracts.ts's ConnectInput.
type ConnectInput struct {
	Host             string         `json:"host"`
	Port             int            `json:"port"`
	Username         string         `json:"username"`
	AuthMethod       string         `json:"authMethod,omitempty"`
	Password         string         `json:"password"`
	PrivateKeyPath   string         `json:"privateKeyPath,omitempty"`
	Passphrase       string         `json:"passphrase,omitempty"`
	AgentSocket      string         `json:"agentSocket,omitempty"`
	HostVerification string         `json:"hostVerification,omitempty"`
	KnownHostsPath   string         `json:"knownHostsPath,omitempty"`
	JumpHost         *JumpHostInput `json:"jumpHost,omitempty"`
}

// ConnectResult mirrors contracts.ts's ConnectResult.
type ConnectResult struct {
	ConnectionID      string `json:"connectionId"`
	HomeDir           string `json:"homeDir,omitempty"`
	FilesystemState   string `json:"filesystemState"`
	SavedConnectionID string `json:"savedConnectionId,omitempty"`
}

// ConnectionStatePayload mirrors contracts.ts's ConnectionStatePayload.
type ConnectionStatePayload struct {
	State           string `json:"state"`
	Message         string `json:"message"`
	Host            string `json:"host,omitempty"`
	ConnectionID    string `json:"connectionId,omitempty"`
	HomeDir         string `json:"homeDir,omitempty"`
	FilesystemState string `json:"filesystemState,omitempty"`
	Reason          string `json:"reason,omitempty"`
	DiagnosticCode  string `json:"diagnosticCode,omitempty"`
	RecoveryHint    string `json:"recoveryHint,omitempty"`
	Recoverable     bool   `json:"recoverable,omitempty"`
	AuthURL         string `json:"authUrl,omitempty"`
}

// RemoteDirectoryEntry mirrors contracts.ts's RemoteDirectoryEntry.
type RemoteDirectoryEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Size       *int64 `json:"size,omitempty"`
	ModifiedAt *int64 `json:"modifiedAt,omitempty"`
}

// RemoteFilePayload mirrors contracts.ts's RemoteFilePayload.
type RemoteFilePayload struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SaveRemoteFileInput mirrors contracts.ts's SaveRemoteFileInput.
type SaveRemoteFileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SaveRemoteFileResult mirrors contracts.ts's SaveRemoteFileResult.
type SaveRemoteFileResult struct {
	Path    string `json:"path"`
	SavedAt string `json:"savedAt"`
}

// CreateRemoteEntryInput mirrors contracts.ts's CreateRemoteEntryInput.
type CreateRemoteEntryInput struct {
	ParentPath string `json:"parentPath"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
}

// RenameRemoteEntryInput mirrors contracts.ts's RenameRemoteEntryInput.
type RenameRemoteEntryInput struct {
	Path     string `json:"path"`
	NextName string `json:"nextName"`
}

// DeleteRemoteEntryInput mirrors contracts.ts's DeleteRemoteEntryInput.
type DeleteRemoteEntryInput struct {
	Path        string `json:"path"`
	OperationID string `json:"operationId,omitempty"`
}

// UploadLocalEntriesInput mirrors contracts.ts's UploadLocalEntriesInput.
type UploadLocalEntriesInput struct {
	OperationID      string   `json:"operationId"`
	RemotePath       string   `json:"remotePath"`
	LocalPaths       []string `json:"localPaths"`
	ConflictStrategy string   `json:"conflictStrategy,omitempty"`
}

// DownloadRemoteEntryInput mirrors contracts.ts's DownloadRemoteEntryInput.
type DownloadRemoteEntryInput struct {
	OperationID      string `json:"operationId"`
	RemotePath       string `json:"remotePath"`
	LocalPath        string `json:"localPath"`
	ConflictStrategy string `json:"conflictStrategy,omitempty"`
}

// FileConflictItem mirrors contracts.ts's FileConflictItem.
type FileConflictItem struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

// FileOperationResult mirrors contracts.ts's FileOperationResult (a
// discriminated union in TS; Go represents both branches in one struct with
// Status selecting which fields are meaningful, matching the JSON shape
// either branch would produce).
type FileOperationResult struct {
	Status       string             `json:"status"`
	SkippedItems int                `json:"skippedItems"`
	Conflicts    []FileConflictItem `json:"conflicts,omitempty"`
}

// FileOperationEvent mirrors contracts.ts's FileOperationEvent.
type FileOperationEvent struct {
	OperationID      string   `json:"operationId"`
	Kind             string   `json:"kind"`
	Status           string   `json:"status"`
	SourcePath       string   `json:"sourcePath"`
	TargetPath       string   `json:"targetPath"`
	Message          string   `json:"message"`
	CompletedItems   int      `json:"completedItems"`
	TotalItems       int      `json:"totalItems"`
	SkippedItems     int      `json:"skippedItems"`
	CurrentPath      string   `json:"currentPath,omitempty"`
	Error            string   `json:"error,omitempty"`
	Retryable        bool     `json:"retryable,omitempty"`
	TransferredBytes *int64   `json:"transferredBytes,omitempty"`
	TotalBytes       *int64   `json:"totalBytes,omitempty"`
	BytesPerSecond   *float64 `json:"bytesPerSecond,omitempty"`
	EtaSeconds       *float64 `json:"etaSeconds,omitempty"`
	Transport        string   `json:"transport,omitempty"`
}

// CreateTerminalInput mirrors contracts.ts's CreateTerminalInput.
type CreateTerminalInput struct {
	SessionName   string `json:"sessionName,omitempty"`
	WorkspacePath string `json:"workspacePath,omitempty"`
}

// CreateTerminalResult mirrors contracts.ts's CreateTerminalResult.
type CreateTerminalResult struct {
	TerminalID     string `json:"terminalId"`
	SessionName    string `json:"sessionName,omitempty"`
	PersistentKind string `json:"persistentKind,omitempty"`
}

// TerminalEvent mirrors contracts.ts's TerminalEvent union.
type TerminalEvent struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Data       string `json:"data,omitempty"`
	Message    string `json:"message,omitempty"`
}

// SavedConnectionSummary includes persisted tunnel configurations.
type SavedConnectionSummary struct {
	ID                string                    `json:"id"`
	DisplayName       string                    `json:"displayName"`
	Host              string                    `json:"host"`
	Port              int                       `json:"port"`
	Username          string                    `json:"username"`
	AuthMethod        string                    `json:"authMethod,omitempty"`
	LastConnectedAt   string                    `json:"lastConnectedAt"`
	LastWorkspacePath string                    `json:"lastWorkspacePath,omitempty"`
	WorkspacePaths    []string                  `json:"workspacePaths"`
	Tunnels           []store.SavedTunnelConfig `json:"tunnels"`
}
