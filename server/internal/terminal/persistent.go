// persistent.go ports src/main/persistent-shell.ts: pure string-building and
// parsing for running a remote shell inside a named tmux/screen session so it
// survives a dropped SSH connection, and re-attaching to it later. Nothing
// here does I/O; the exec/attach plumbing lives in pty.go.
package terminal

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// PersistentShellKind mirrors contracts.ts's PersistentShellKind union.
type PersistentShellKind string

const (
	ShellKindTmux   PersistentShellKind = "tmux"
	ShellKindScreen PersistentShellKind = "screen"
	ShellKindNone   PersistentShellKind = "none"
)

// RemoteShellSessionSummary mirrors contracts.ts's RemoteShellSessionSummary.
type RemoteShellSessionSummary struct {
	Name      string `json:"name"`
	Attached  bool   `json:"attached"`
	Windows   *int   `json:"windows,omitempty"`
	CreatedAt *int64 `json:"createdAt,omitempty"`
}

// RemoteShellSupport mirrors contracts.ts's RemoteShellSupport.
type RemoteShellSupport struct {
	Kind     PersistentShellKind         `json:"kind"`
	Sessions []RemoteShellSessionSummary `json:"sessions"`
}

// SessionNamePrefix mirrors SESSION_NAME_PREFIX.
const SessionNamePrefix = "sshstudio"

// tmuxListSeparator is a control character used to split tmux's list-sessions
// output instead of a printable delimiter, since session names may contain
// spaces, ':' or '.'. Mirrors TMUX_LIST_SEPARATOR.
const tmuxListSeparator = "\u0001"

// tmuxListFormat mirrors TMUX_LIST_FORMAT.
var tmuxListFormat = strings.Join([]string{
	"#{session_name}",
	"#{session_windows}",
	"#{session_attached}",
	"#{session_created}",
}, tmuxListSeparator)

// BuildSupportProbeCommand mirrors buildSupportProbeCommand.
func BuildSupportProbeCommand() string {
	return strings.Join([]string{
		"if command -v tmux >/dev/null 2>&1; then echo tmux;",
		"elif command -v screen >/dev/null 2>&1; then echo screen;",
		"else echo none; fi",
	}, " ")
}

// ParseSupportProbe mirrors parseSupportProbe.
func ParseSupportProbe(stdout string) PersistentShellKind {
	fields := strings.Fields(stdout)
	value := ""
	if len(fields) > 0 {
		value = fields[len(fields)-1]
	}
	switch PersistentShellKind(value) {
	case ShellKindTmux, ShellKindScreen:
		return PersistentShellKind(value)
	default:
		return ShellKindNone
	}
}

var invalidSessionNameChars = regexp.MustCompile(`[^\w.-]+`)
var leadingTrailingDashes = regexp.MustCompile(`^-+|-+$`)

// NormalizeSessionName mirrors normalizeSessionName: session names end up
// inside shell commands and tmux target specifiers, so only a conservative
// character set is allowed. Anything else is replaced rather than rejected,
// because names are often derived from workspace paths.
func NormalizeSessionName(raw string) string {
	cleaned := strings.TrimSpace(raw)
	cleaned = invalidSessionNameChars.ReplaceAllString(cleaned, "-")
	cleaned = leadingTrailingDashes.ReplaceAllString(cleaned, "")
	if len(cleaned) > 60 {
		cleaned = cleaned[:60]
	}
	if cleaned == "" {
		return SessionNamePrefix
	}
	return cleaned
}

// BuildSessionName mirrors buildSessionName.
func BuildSessionName(workspacePath string, index int) string {
	var leaf string
	for _, segment := range strings.Split(workspacePath, "/") {
		if segment != "" {
			leaf = segment
		}
	}

	base := SessionNamePrefix
	if leaf != "" {
		base = SessionNamePrefix + "-" + leaf
	}
	if index > 1 {
		base = fmt.Sprintf("%s-%d", base, index)
	}
	return NormalizeSessionName(base)
}

// BuildListSessionsCommand mirrors buildListSessionsCommand. A nil return
// means the caller should skip listing (no multiplexer available).
func BuildListSessionsCommand(kind PersistentShellKind) *string {
	switch kind {
	case ShellKindTmux:
		// `list-sessions` exits non-zero when no server is running, which is
		// not an error for us: an empty list is the correct answer.
		cmd := fmt.Sprintf("tmux list-sessions -F %s 2>/dev/null || true", QuoteForShell(tmuxListFormat))
		return &cmd
	case ShellKindScreen:
		cmd := "screen -ls 2>/dev/null || true"
		return &cmd
	default:
		return nil
	}
}

// ParseSessionList mirrors parseSessionList.
func ParseSessionList(kind PersistentShellKind, stdout string) []RemoteShellSessionSummary {
	switch kind {
	case ShellKindTmux:
		return parseTmuxSessions(stdout)
	case ShellKindScreen:
		return parseScreenSessions(stdout)
	default:
		return []RemoteShellSessionSummary{}
	}
}

func parseTmuxSessions(stdout string) []RemoteShellSessionSummary {
	sessions := []RemoteShellSessionSummary{}

	for _, line := range strings.Split(stdout, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}

		fields := strings.Split(line, tmuxListSeparator)
		var name, windows, attached, created string
		if len(fields) > 0 {
			name = fields[0]
		}
		if len(fields) > 1 {
			windows = fields[1]
		}
		if len(fields) > 2 {
			attached = fields[2]
		}
		if len(fields) > 3 {
			created = fields[3]
		}
		if name == "" {
			continue
		}

		attachedTrimmed := strings.TrimSpace(attached)
		sessions = append(sessions, RemoteShellSessionSummary{
			Name:      strings.TrimSpace(name),
			Windows:   toPositiveInteger(windows),
			Attached:  attachedTrimmed != "0" && attachedTrimmed != "",
			CreatedAt: toPositiveInteger64(created),
		})
	}

	return sessions
}

// screenSessionPattern matches the pid.name prefix of a `screen -ls` line,
// e.g. "3121.sshstudio-runs". Mirrors the /^(\d+)\.(\S+)/ regex.
var screenSessionPattern = regexp.MustCompile(`^(\d+)\.(\S+)`)
var screenAttachedPattern = regexp.MustCompile(`(?i)\(attached\)`)

// parseScreenSessions mirrors parseScreenSessions. `screen -ls` prints lines
// like:
//
//	\t12345.sshstudio-runs\t(01/02/2026 10:11:12 AM)\t(Detached)
//
// Older builds omit the timestamp, so only the pid.name and the state are
// treated as required.
func parseScreenSessions(stdout string) []RemoteShellSessionSummary {
	sessions := []RemoteShellSessionSummary{}

	for _, rawLine := range strings.Split(stdout, "\n") {
		line := strings.TrimSpace(rawLine)
		match := screenSessionPattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}

		sessions = append(sessions, RemoteShellSessionSummary{
			Name:     match[1] + "." + match[2],
			Attached: screenAttachedPattern.MatchString(line),
		})
	}

	return sessions
}

// PersistentShellCommandInput mirrors PersistentShellCommandInput.
type PersistentShellCommandInput struct {
	Kind          PersistentShellKind
	SessionName   string
	WorkspacePath string
	// Env is exported to the attach command. A newly created session inherits
	// it (both tmux and screen copy the client environment), so vision mode's
	// DISPLAY can be set without typing into a session that may be running a
	// job.
	Env map[string]string
}

var validEnvName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func buildEnvPrefix(env map[string]string) string {
	if len(env) == 0 {
		return ""
	}

	// Deterministic order for testability; ssh-session.ts relies on
	// Object.entries' insertion order, which Go maps don't preserve, but the
	// attach command's correctness does not depend on ordering between
	// distinct variables (each is an independent `NAME=value` assignment).
	names := make([]string, 0, len(env))
	for name := range env {
		if validEnvName.MatchString(name) {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return ""
	}
	sortStrings(names)

	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s=%s", name, QuoteForShell(env[name])))
	}
	return strings.Join(parts, " ") + " "
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j-1] > values[j]; j-- {
			values[j-1], values[j] = values[j], values[j-1]
		}
	}
}

// BuildSetSessionEnvCommand mirrors buildSetSessionEnvCommand: sets a
// variable in a running tmux session's environment. It applies to panes and
// windows created afterwards, not to the shell already running, which is
// exactly what we want: no keystrokes are sent to a live job. screen has no
// equivalent, so it returns nil and the caller skips it.
func BuildSetSessionEnvCommand(kind PersistentShellKind, sessionName, name, value string) *string {
	if kind != ShellKindTmux || !validEnvName.MatchString(name) {
		return nil
	}

	cmd := fmt.Sprintf("tmux setenv -t %s %s %s", QuoteForShell(NormalizeSessionName(sessionName)), name, QuoteForShell(value))
	return &cmd
}

// ErrNoMultiplexer mirrors the "No persistent shell multiplexer is available
// on the remote host" error thrown by buildAttachCommand/buildKillSessionCommand.
var ErrNoMultiplexer = fmt.Errorf("no persistent shell multiplexer is available on the remote host")

// BuildAttachCommand mirrors buildAttachCommand: builds the login-shell
// command that attaches to sessionName, creating it if it does not exist
// yet. `tmux new-session -A` would be shorter but is not available on the
// tmux 1.8 builds still shipped by older enterprise distros, so an explicit
// has-session probe is used instead.
func BuildAttachCommand(input PersistentShellCommandInput) (string, error) {
	name := NormalizeSessionName(input.SessionName)
	quotedName := QuoteForShell(name)
	envPrefix := buildEnvPrefix(input.Env)

	switch input.Kind {
	case ShellKindTmux:
		createArgs := []string{fmt.Sprintf("%stmux -u new-session -s %s", envPrefix, quotedName)}
		if strings.TrimSpace(input.WorkspacePath) != "" {
			createArgs = append(createArgs, fmt.Sprintf("-c %s", QuoteForShell(input.WorkspacePath)))
		}

		return strings.Join([]string{
			fmt.Sprintf("if tmux has-session -t %s 2>/dev/null; then", quotedName),
			fmt.Sprintf("exec %stmux -u attach-session -t %s;", envPrefix, quotedName),
			"else",
			fmt.Sprintf("exec %s;", strings.Join(createArgs, " ")),
			"fi",
		}, " "), nil

	case ShellKindScreen:
		// -xRR: attach to a running session (shared), reattach if detached,
		// and create one when nothing matches.
		cd := ""
		if strings.TrimSpace(input.WorkspacePath) != "" {
			cd = fmt.Sprintf("cd %s; ", QuoteForShell(input.WorkspacePath))
		}
		return fmt.Sprintf("%sexec %sscreen -xRR -S %s", cd, envPrefix, quotedName), nil

	default:
		return "", ErrNoMultiplexer
	}
}

// BuildKillSessionCommand mirrors buildKillSessionCommand.
func BuildKillSessionCommand(kind PersistentShellKind, sessionName string) (string, error) {
	quotedName := QuoteForShell(NormalizeSessionName(sessionName))

	switch kind {
	case ShellKindTmux:
		return fmt.Sprintf("tmux kill-session -t %s", quotedName), nil
	case ShellKindScreen:
		return fmt.Sprintf("screen -S %s -X quit", quotedName), nil
	default:
		return "", ErrNoMultiplexer
	}
}

func toPositiveInteger(value string) *int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return nil
	}
	return &parsed
}

func toPositiveInteger64(value string) *int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed <= 0 {
		return nil
	}
	return &parsed
}

// QuoteForShell is a single-quoting helper for remote shell commands, ported
// from src/main/shell.ts's quoteForShell. Duplicated locally (rather than
// imported from internal/ssh, which already has its own identical copy) so
// this package has no dependency on internal/ssh while it may be edited
// concurrently by another workstream.
func QuoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
