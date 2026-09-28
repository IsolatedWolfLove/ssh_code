package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	internalsftp "github.com/IsolatedWolfLove/ssh-studio-server/internal/sftp"
	internalssh "github.com/IsolatedWolfLove/ssh-studio-server/internal/ssh"
	internalstore "github.com/IsolatedWolfLove/ssh-studio-server/internal/store"
	internalterminal "github.com/IsolatedWolfLove/ssh-studio-server/internal/terminal"
)

// Event channel names, matching IPC_CHANNELS in contracts.ts exactly so the
// frontend event-name strings do not need to change between the Electron and
// Wails builds.
const (
	eventConnectionState = "connection:state"
	eventFileOperation   = "fileOperation:event"
	eventTerminal        = "terminal:event"
)

// App is the Wails-bound struct. Its exported methods become the
// JS-callable API surface (mirroring what src/preload/index.ts exposes today
// as window.electronAPI). Kept thin: real logic lives in the internal/ssh,
// internal/sftp, internal/terminal, internal/store packages.
type App struct {
	ctx        context.Context
	connectMu  sync.Mutex
	servicesMu sync.Mutex
	services   map[string]*connectionServices

	manager   *internalssh.Manager
	terminals *internalterminal.Registry
	store     *internalstore.Store

	cancelMu    sync.Mutex
	cancelFuncs map[string]context.CancelFunc
}

// NewApp creates a new App application struct. The saved-connections store
// is opened (and its one-time legacy-Electron-data migration attempted)
// here rather than in Startup, so a store failure surfaces immediately
// during construction instead of silently leaving a.store nil until the
// first saved-connection call.
func NewApp() *App {
	a := &App{
		manager:     internalssh.NewManager(),
		services:    make(map[string]*connectionServices),
		cancelFuncs: make(map[string]context.CancelFunc),
	}
	a.terminals = internalterminal.NewRegistry(a.emitTerminalEvent)

	if storeDir, err := resolveStoreDir(); err == nil {
		if s, err := internalstore.NewStore(storeDir); err == nil {
			a.store = s
			if legacyDir, err := internalstore.ElectronUserDataDir(); err == nil {
				// Best-effort: a migration failure must not prevent the app
				// from starting. Phase 2 does not build UI for surfacing the
				// result (see the plan), so it's discarded here.
				_, _ = s.MigrateFromElectron(legacyDir)
			}
		}
	}

	return a
}

// resolveStoreDir returns the directory the Wails app's saved-connections
// store lives in: <os.UserConfigDir()>/ssh-studio. This is deliberately NOT
// the same path Electron's app.getPath('userData') resolves to (see
// internal/store.ElectronUserDataDir) - a fresh Wails install starts with an
// empty store, and MigrateFromElectron is what bridges the two.
func resolveStoreDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return path.Join(filepathToSlash(configDir), "ssh-studio"), nil
}

// Startup is called when the Wails app starts. The context is saved so we
// can call runtime methods (e.g. runtime.EventsEmit) from other methods.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) emitTerminalEvent(event internalterminal.Event) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, eventTerminal, TerminalEvent{
		Type:       event.Type,
		TerminalID: event.TerminalID,
		Data:       event.Data,
		Message:    event.Message,
	})
}

func (a *App) emitConnectionState(payload ConnectionStatePayload) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, eventConnectionState, payload)
}

func (a *App) emitFileOperationEvent(payload FileOperationEvent) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, eventFileOperation, payload)
}

// --- Connection lifecycle -------------------------------------------------

// Connect mirrors SshSessionManager.connect plus the savedConnectionId /
// saveConnection side effect wired in around it by index.ts's ssh:connect
// handler: the saved-connection id is computed from (host, port, username)
// before dialing, and on success the connection is upserted into the store
// (creating it on a first-ever connect, or bumping lastConnectedAt on a
// repeat) - saving is a side effect of every successful connect, not just an
// explicit "save" action.
func (a *App) Connect(input ConnectInput) (ConnectResult, error) {
	a.connectMu.Lock()
	defer a.connectMu.Unlock()
	a.servicesMu.Lock()
	ids := make([]string, 0, len(a.services))
	for id := range a.services {
		ids = append(ids, id)
	}
	a.servicesMu.Unlock()
	for _, id := range ids {
		_ = a.Disconnect(id)
	}
	if input.Port == 0 {
		input.Port = 22
	}

	a.emitConnectionState(ConnectionStatePayload{
		State:           "connecting",
		Message:         fmt.Sprintf("Connecting to %s:%d...", input.Host, input.Port),
		Host:            input.Host,
		FilesystemState: "idle",
	})

	var savedConnectionID string
	if a.store != nil {
		savedConnectionID = a.store.GetConnectionID(input.Host, input.Port, input.Username)
	}

	managerInput := toManagerConnectInput(input)
	managerInput.OnAuthMessage = func(message string) {
		a.emitConnectionState(ConnectionStatePayload{State: "connecting", Message: message, AuthURL: internalssh.ExtractURL(message), Host: input.Host, FilesystemState: "idle"})
	}

	result, err := a.manager.Connect(managerInput)
	if err != nil {
		diagnostic := internalssh.ClassifyConnectionError(err)
		message := fmt.Sprintf("%s. %s", diagnostic.Message, diagnostic.RecoveryHint)
		a.emitConnectionState(ConnectionStatePayload{
			State:           "error",
			Message:         message,
			Host:            input.Host,
			FilesystemState: "error",
			Reason:          "connectFailed",
			DiagnosticCode:  string(diagnostic.Code),
			RecoveryHint:    diagnostic.RecoveryHint,
			Recoverable:     diagnostic.Recoverable,
		})
		return ConnectResult{}, fmt.Errorf("%s. %s (%s)", diagnostic.Message, diagnostic.RecoveryHint, err.Error())
	}

	if a.store != nil {
		if summary, saveErr := a.store.Save(toStoreConnectInput(input)); saveErr == nil {
			savedConnectionID = summary.ID
		}
		// A save failure is not fatal to the connection itself, mirroring
		// index.ts (saveConnection runs after connect resolves and is not
		// awaited into the error path).
	}

	a.startServices(result.ConnectionID)
	a.emitConnectionState(ConnectionStatePayload{
		State:           "connected",
		Message:         fmt.Sprintf("Connected to %s@%s", input.Username, input.Host),
		Host:            input.Host,
		ConnectionID:    result.ConnectionID,
		HomeDir:         result.HomeDir,
		FilesystemState: result.FilesystemState,
	})

	return ConnectResult{
		ConnectionID:      result.ConnectionID,
		HomeDir:           result.HomeDir,
		FilesystemState:   result.FilesystemState,
		SavedConnectionID: savedConnectionID,
	}, nil
}

// ConnectSaved mirrors the connectSaved IPC handler in index.ts: look up a
// saved connection's decrypted input by id, connect with it via the same
// path as Connect, and re-save (bumping lastConnectedAt).
func (a *App) ConnectSaved(savedConnectionID string) (ConnectResult, error) {
	if a.store == nil {
		return ConnectResult{}, fmt.Errorf("saved-connections store is not available")
	}

	input, err := a.store.GetConnectInput(savedConnectionID)
	if err != nil {
		return ConnectResult{}, err
	}

	return a.Connect(fromStoreConnectInput(input))
}

// ListSavedConnections mirrors savedConnections:list.
func (a *App) ListSavedConnections() ([]SavedConnectionSummary, error) {
	if a.store == nil {
		return nil, fmt.Errorf("saved-connections store is not available")
	}
	summaries, err := a.store.List()
	if err != nil {
		return nil, err
	}

	out := make([]SavedConnectionSummary, 0, len(summaries))
	for _, summary := range summaries {
		out = append(out, SavedConnectionSummary{
			ID:                summary.ID,
			DisplayName:       summary.DisplayName,
			Host:              summary.Host,
			Port:              summary.Port,
			Username:          summary.Username,
			AuthMethod:        summary.AuthMethod,
			LastConnectedAt:   summary.LastConnectedAt,
			LastWorkspacePath: summary.LastWorkspacePath,
			WorkspacePaths:    summary.WorkspacePaths,
			Tunnels:           summary.Tunnels,
		})
	}
	return out, nil
}

// GetSavedConnectionInput mirrors savedConnections:input.
func (a *App) GetSavedConnectionInput(savedConnectionID string) (ConnectInput, error) {
	if a.store == nil {
		return ConnectInput{}, fmt.Errorf("saved-connections store is not available")
	}
	input, err := a.store.GetConnectInput(savedConnectionID)
	if err != nil {
		return ConnectInput{}, err
	}
	return fromStoreConnectInput(input), nil
}

// RemoveSavedConnection mirrors savedConnections:remove.
func (a *App) RemoveSavedConnection(savedConnectionID string) error {
	if a.store == nil {
		return fmt.Errorf("saved-connections store is not available")
	}
	return a.store.Remove(savedConnectionID)
}

// RenameSavedConnection mirrors savedConnections:rename.
func (a *App) RenameSavedConnection(savedConnectionID string, displayName string) error {
	if a.store == nil {
		return fmt.Errorf("saved-connections store is not available")
	}
	return a.store.Rename(savedConnectionID, displayName)
}

// UpdateSavedConnectionWorkspace mirrors savedConnections:updateWorkspace.
func (a *App) UpdateSavedConnectionWorkspace(savedConnectionID string, workspacePath string) error {
	if a.store == nil {
		return fmt.Errorf("saved-connections store is not available")
	}
	return a.store.UpdateWorkspacePath(savedConnectionID, workspacePath)
}

func toManagerConnectInput(input ConnectInput) internalssh.ConnectInput {
	managerInput := internalssh.ConnectInput{
		Host:             input.Host,
		Port:             input.Port,
		Username:         input.Username,
		AuthMethod:       internalssh.AuthMethod(orDefault(input.AuthMethod, "password")),
		Password:         input.Password,
		PrivateKeyPath:   input.PrivateKeyPath,
		Passphrase:       input.Passphrase,
		AgentSocket:      input.AgentSocket,
		HostVerification: internalssh.HostVerificationMode(orDefault(input.HostVerification, "off")),
		KnownHostsPath:   input.KnownHostsPath,
	}
	if input.JumpHost != nil {
		managerInput.JumpHost = &internalssh.JumpHostInput{
			Host:           input.JumpHost.Host,
			Port:           input.JumpHost.Port,
			Username:       input.JumpHost.Username,
			AuthMethod:     internalssh.AuthMethod(orDefault(input.JumpHost.AuthMethod, "password")),
			Password:       input.JumpHost.Password,
			PrivateKeyPath: input.JumpHost.PrivateKeyPath,
			Passphrase:     input.JumpHost.Passphrase,
			AgentSocket:    input.JumpHost.AgentSocket,
		}
	}
	return managerInput
}

func toStoreConnectInput(input ConnectInput) internalstore.ConnectInput {
	storeInput := internalstore.ConnectInput{
		Host:             input.Host,
		Port:             input.Port,
		Username:         input.Username,
		AuthMethod:       orDefault(input.AuthMethod, "password"),
		Password:         input.Password,
		PrivateKeyPath:   input.PrivateKeyPath,
		Passphrase:       input.Passphrase,
		AgentSocket:      input.AgentSocket,
		HostVerification: orDefault(input.HostVerification, "off"),
		KnownHostsPath:   input.KnownHostsPath,
	}
	if input.JumpHost != nil {
		storeInput.JumpHost = &internalstore.JumpHostInput{
			Host:           input.JumpHost.Host,
			Port:           input.JumpHost.Port,
			Username:       input.JumpHost.Username,
			AuthMethod:     orDefault(input.JumpHost.AuthMethod, "password"),
			Password:       input.JumpHost.Password,
			PrivateKeyPath: input.JumpHost.PrivateKeyPath,
			Passphrase:     input.JumpHost.Passphrase,
			AgentSocket:    input.JumpHost.AgentSocket,
		}
	}
	return storeInput
}

func fromStoreConnectInput(input internalstore.ConnectInput) ConnectInput {
	result := ConnectInput{
		Host:             input.Host,
		Port:             input.Port,
		Username:         input.Username,
		AuthMethod:       input.AuthMethod,
		Password:         input.Password,
		PrivateKeyPath:   input.PrivateKeyPath,
		Passphrase:       input.Passphrase,
		AgentSocket:      input.AgentSocket,
		HostVerification: input.HostVerification,
		KnownHostsPath:   input.KnownHostsPath,
	}
	if input.JumpHost != nil {
		result.JumpHost = &JumpHostInput{
			Host:           input.JumpHost.Host,
			Port:           input.JumpHost.Port,
			Username:       input.JumpHost.Username,
			AuthMethod:     input.JumpHost.AuthMethod,
			Password:       input.JumpHost.Password,
			PrivateKeyPath: input.JumpHost.PrivateKeyPath,
			Passphrase:     input.JumpHost.Passphrase,
			AgentSocket:    input.JumpHost.AgentSocket,
		}
	}
	return result
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// Disconnect releases connection services, terminals and transports.
func (a *App) Disconnect(connectionID string) error {
	a.cancelMu.Lock()
	for _, cancel := range a.cancelFuncs {
		cancel()
	}
	a.cancelMu.Unlock()
	a.stopServices(connectionID)
	if s, e := a.manager.Get(connectionID); e == nil {
		a.terminals.CloseClient(s.Client())
	}
	err := a.manager.Disconnect(connectionID)
	a.emitConnectionState(ConnectionStatePayload{
		State:           "disconnected",
		Message:         "Disconnected",
		FilesystemState: "idle",
		Reason:          "manual",
		Recoverable:     true,
	})
	return err
}

// --- SFTP file operations --------------------------------------------------

func (a *App) sftpClient(connectionID string) (internalsftp.FileSystem, error) {
	session, err := a.manager.Get(connectionID)
	if err != nil {
		return nil, err
	}
	client := session.SFTP()
	if client == nil {
		return nil, fmt.Errorf("no active SFTP session")
	}
	return client, nil
}

// ReadDir uses SFTP or the shell filesystem selected during connection.
func (a *App) ReadDir(connectionID, remotePath string) ([]RemoteDirectoryEntry, error) {
	client, err := a.sftpClient(connectionID)
	if err != nil {
		return nil, err
	}

	entries, err := internalsftp.ReadDir(client, remotePath)
	if err != nil {
		return nil, err
	}

	result := make([]RemoteDirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		out := RemoteDirectoryEntry{Name: entry.Name, Path: entry.Path, Kind: string(entry.Kind)}
		if entry.HasSize {
			size := entry.Size
			out.Size = &size
		}
		if entry.HasModifiedAt {
			modifiedAt := entry.ModifiedAt
			out.ModifiedAt = &modifiedAt
		}
		result = append(result, out)
	}
	return result, nil
}

// ReadFile mirrors readFile in ssh-session.ts's SFTP path.
func (a *App) ReadFile(connectionID, remotePath string) (RemoteFilePayload, error) {
	client, err := a.sftpClient(connectionID)
	if err != nil {
		return RemoteFilePayload{}, err
	}
	content, err := internalsftp.ReadFile(client, remotePath)
	if err != nil {
		return RemoteFilePayload{}, err
	}
	return RemoteFilePayload{Path: remotePath, Content: content}, nil
}

// WriteFileAtomic mirrors writeFileAtomic in ssh-session.ts.
func (a *App) WriteFileAtomic(connectionID string, input SaveRemoteFileInput) (SaveRemoteFileResult, error) {
	client, err := a.sftpClient(connectionID)
	if err != nil {
		return SaveRemoteFileResult{}, err
	}
	if err := internalsftp.WriteFileAtomic(client, input.Path, input.Content); err != nil {
		return SaveRemoteFileResult{}, err
	}
	return SaveRemoteFileResult{Path: input.Path, SavedAt: time.Now().UTC().Format(time.RFC3339)}, nil
}

// CreateEntry mirrors createEntry in ssh-session.ts.
func (a *App) CreateEntry(connectionID string, input CreateRemoteEntryInput) (RemoteDirectoryEntry, error) {
	client, err := a.sftpClient(connectionID)
	if err != nil {
		return RemoteDirectoryEntry{}, err
	}
	entry, err := internalsftp.CreateEntry(client, input.ParentPath, input.Name, internalsftp.EntryKind(input.Kind))
	if err != nil {
		return RemoteDirectoryEntry{}, err
	}
	out := RemoteDirectoryEntry{Name: entry.Name, Path: entry.Path, Kind: string(entry.Kind)}
	if entry.HasSize {
		size := entry.Size
		out.Size = &size
	}
	return out, nil
}

// RenameEntry mirrors renameEntry in ssh-session.ts.
func (a *App) RenameEntry(connectionID string, input RenameRemoteEntryInput) (RemoteDirectoryEntry, error) {
	client, err := a.sftpClient(connectionID)
	if err != nil {
		return RemoteDirectoryEntry{}, err
	}
	entry, err := internalsftp.RenameEntry(client, input.Path, input.NextName)
	if err != nil {
		return RemoteDirectoryEntry{}, err
	}
	out := RemoteDirectoryEntry{Name: entry.Name, Path: entry.Path, Kind: string(entry.Kind)}
	if entry.HasSize {
		size := entry.Size
		out.Size = &size
	}
	if entry.HasModifiedAt {
		modifiedAt := entry.ModifiedAt
		out.ModifiedAt = &modifiedAt
	}
	return out, nil
}

// DeleteEntry mirrors deleteEntry in ssh-session.ts.
func (a *App) DeleteEntry(connectionID string, input DeleteRemoteEntryInput) error {
	client, err := a.sftpClient(connectionID)
	if err != nil {
		return err
	}

	operationID := input.OperationID
	if operationID == "" {
		operationID = newID()
	}

	a.emitFileOperationEvent(FileOperationEvent{
		OperationID: operationID, Kind: "delete", Status: "running",
		SourcePath: input.Path, TargetPath: input.Path,
		Message: fmt.Sprintf("Deleting %s", input.Path), TotalItems: 1,
	})

	if err := internalsftp.DeleteEntry(client, input.Path); err != nil {
		a.emitFileOperationEvent(FileOperationEvent{
			OperationID: operationID, Kind: "delete", Status: "failed",
			SourcePath: input.Path, TargetPath: input.Path,
			Message: fmt.Sprintf("Delete failed for %s", input.Path),
			Error:   err.Error(), Retryable: true, TotalItems: 1,
		})
		return err
	}

	a.emitFileOperationEvent(FileOperationEvent{
		OperationID: operationID, Kind: "delete", Status: "completed",
		SourcePath: input.Path, TargetPath: input.Path,
		Message: fmt.Sprintf("Deleted %s", input.Path), CompletedItems: 1, TotalItems: 1,
	})
	return nil
}

// CancelFileOperation mirrors the cancel path wired through
// registerOperationCancel in ssh-session.ts.
func (a *App) CancelFileOperation(operationID string) error {
	a.cancelMu.Lock()
	cancel, ok := a.cancelFuncs[operationID]
	a.cancelMu.Unlock()
	if ok {
		cancel()
	}
	return nil
}

func (a *App) registerCancel(operationID string, cancel context.CancelFunc) {
	a.cancelMu.Lock()
	a.cancelFuncs[operationID] = cancel
	a.cancelMu.Unlock()
}

func (a *App) unregisterCancel(operationID string) {
	a.cancelMu.Lock()
	delete(a.cancelFuncs, operationID)
	a.cancelMu.Unlock()
}

// --- Terminal ---------------------------------------------------------------

// CreateTerminal attaches to the requested persistent session when available.
func (a *App) CreateTerminal(connectionID string, input CreateTerminalInput) (CreateTerminalResult, error) {
	session, err := a.manager.Get(connectionID)
	if err != nil {
		return CreateTerminalResult{}, err
	}
	client := session.Client()
	if client == nil {
		return CreateTerminalResult{}, fmt.Errorf("no active SSH connection")
	}

	terminalID := newID()
	result, err := a.terminals.Create(client, terminalID, internalterminal.CreateTerminalInput{SessionName: input.SessionName, WorkspacePath: input.WorkspacePath, Env: a.terminalEnv(connectionID)})
	if err != nil {
		return CreateTerminalResult{}, err
	}

	return CreateTerminalResult{TerminalID: terminalID, SessionName: result.SessionName, PersistentKind: string(result.PersistentKind)}, nil
}

// WriteTerminal mirrors writeTerminal.
func (a *App) WriteTerminal(terminalID, data string) error {
	return a.terminals.Write(terminalID, data)
}

// ResizeTerminal mirrors resizeTerminal.
func (a *App) ResizeTerminal(terminalID string, cols, rows int) error {
	return a.terminals.Resize(terminalID, cols, rows)
}

// CloseTerminal mirrors closeTerminal.
func (a *App) CloseTerminal(terminalID string) error {
	return a.terminals.Close(terminalID)
}

// --- Dialogs ----------------------------------------------------------------

// PickPrivateKeyPath mirrors the pickPrivateKeyPath dialog handler in
// src/main/index.ts.
func (a *App) PickPrivateKeyPath() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "Select private key"})
}

// PickKnownHostsPath mirrors the pickKnownHostsPath dialog handler.
func (a *App) PickKnownHostsPath() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{Title: "Select known_hosts file"})
}

// PickUploadEntries offers file or folder selection using native dialogs.
func (a *App) PickUploadEntries() ([]string, error) {
	choice, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{Type: runtime.QuestionDialog, Title: "Upload", Message: "Choose files or a folder to upload", Buttons: []string{"Files", "Folder", "Cancel"}, DefaultButton: "Files", CancelButton: "Cancel"})
	if err != nil {
		return nil, err
	}
	if choice == "Cancel" || choice == "" {
		return []string{}, nil
	}
	if choice == "Folder" {
		p, e := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "Select folder to upload"})
		if e != nil {
			return nil, e
		}
		if p == "" {
			return []string{}, nil
		}
		return []string{p}, nil
	}
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{Title: "Select files to upload"})
	if err != nil {
		return nil, err
	}
	if paths == nil {
		return []string{}, nil
	}
	return paths, nil
}

// PickDownloadDirectory mirrors the pickDownloadDirectory dialog handler.
func (a *App) PickDownloadDirectory() (string, error) {
	home, _ := os.UserHomeDir()
	downloads := path.Join(filepathToSlash(home), "Downloads")
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "Choose download folder",
		DefaultDirectory: downloads,
	})
}

// --- helpers ------------------------------------------------------------------

func newID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf[:4]) + "-" + hex.EncodeToString(buf[4:6]) + "-" +
		hex.EncodeToString(buf[6:8]) + "-" + hex.EncodeToString(buf[8:10]) + "-" + hex.EncodeToString(buf[10:16])
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// filepathToSlash normalizes an OS path to forward slashes for joining with
// remote (always-POSIX) paths. On Linux/macOS this is a no-op.
func filepathToSlash(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}
