package lsp

import (
	"errors"
	"net/url"
	"path"
	"strings"
)

// normalizeRemotePath mirrors normalizeRemotePath in
// language-server-manager.ts: language-server paths must be absolute POSIX
// paths; this trims and normalizes (collapsing ".."/"." segments and
// duplicate slashes).
func normalizeRemotePath(remotePath string) (string, error) {
	trimmed := strings.TrimSpace(remotePath)
	if !strings.HasPrefix(trimmed, "/") {
		return "", errors.New("language server paths must be absolute")
	}
	return path.Clean(trimmed), nil
}

// RemotePathToFileURI mirrors remotePathToFileUri: builds a plain file://
// URI whose path segments are percent-encoded.
//
// Confirmed from source (not assumed): the remote language server process
// is started ON the remote host itself, over the same SSH connection (see
// StartCommand/manager.go), so a file:// URI naming a path on that host is
// valid there - there is no local/remote path collision to disambiguate via
// a custom scheme, and language-server-manager.ts indeed just uses
// `file://` directly.
//
// Escaping note: this uses Go's url.PathEscape per segment, which follows
// RFC 3986's pchar rules and differs slightly from JavaScript's
// encodeURIComponent for a handful of characters (e.g. "!", "'", "(", ")",
// "*" are left unescaped by PathEscape but escaped by encodeURIComponent).
// Both are valid, standards-compliant percent-encodings and both round-trip
// correctly through this package's own FileURIToRemotePath, and the actual
// remote `typescript-language-server` parses URIs per the same RFC 3986
// rules (via vscode-uri), so this difference should not cause interop
// issues in practice - flagged here since it is a real, if low-risk,
// deviation from the original's exact byte-for-byte escaping.
func RemotePathToFileURI(remotePath string) (string, error) {
	normalized, err := normalizeRemotePath(remotePath)
	if err != nil {
		return "", err
	}

	segments := strings.Split(normalized, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return "file://" + strings.Join(segments, "/"), nil
}

// FileURIToRemotePath mirrors fileUriToRemotePath: the inverse of
// RemotePathToFileURI. Returns ("", false) for anything that is not a bare
// file:// URI (wrong scheme, or a host component present).
func FileURIToRemotePath(uri string) (string, bool) {
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Scheme != "file" || parsed.Host != "" {
		return "", false
	}
	// url.Parse already percent-decodes Path, mirroring the original's
	// explicit decodeURIComponent(parsed.pathname) step.
	normalized, err := normalizeRemotePath(parsed.Path)
	if err != nil {
		return "", false
	}
	return normalized, true
}
