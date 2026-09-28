package ssh

import (
	"errors"
	"testing"
)

func TestClassifyConnectionError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want DiagnosticCode
	}{
		{"wrong password", errors.New("All configured authentication methods failed with password"), DiagnosticWrongPassword},
		{"generic auth failure", errors.New("ssh: handshake failed: authentication failed"), DiagnosticAuthenticationFailed},
		{"permission denied", errors.New("Permission denied (publickey)"), DiagnosticAuthenticationFailed},
		{"host key mismatch", errors.New("host key verification failed"), DiagnosticKnownHosts},
		{"fingerprint mismatch", errors.New("remote host identification has changed: fingerprint mismatch"), DiagnosticKnownHosts},
		{"private key parse failure", errors.New("cannot parse privateKey: invalid format"), DiagnosticPrivateKey},
		{"passphrase required", errors.New("passphrase required for encrypted key"), DiagnosticPrivateKey},
		{"host unreachable", errors.New("dial tcp: connect: no route to host"), DiagnosticHostUnreachable},
		{"connection refused", errors.New("dial tcp 1.2.3.4:22: connect: connection refused (ECONNREFUSED)"), DiagnosticHostUnreachable},
		{"timed out generic", errors.New("dial tcp: operation timed out"), DiagnosticHostUnreachable},
		{"tailscale handshake timeout", errors.New("timed out waiting for handshake to complete"), DiagnosticAuthenticationFailed},
		{"unknown", errors.New("something unexpected happened"), DiagnosticUnknown},
		{"nil error", nil, DiagnosticUnknown},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyConnectionError(tc.err)
			if got.Code != tc.want {
				t.Errorf("ClassifyConnectionError(%v) = %q, want %q", tc.err, got.Code, tc.want)
			}
			if got.Message == "" {
				t.Errorf("expected non-empty message for %v", tc.err)
			}
			if got.RecoveryHint == "" {
				t.Errorf("expected non-empty recovery hint for %v", tc.err)
			}
		})
	}
}

func TestExtractURL(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{"plain url", "Visit https://login.tailscale.com/a/abc123 to continue", "https://login.tailscale.com/a/abc123"},
		{"trailing punctuation stripped", "Open https://example.com/path, then wait.", "https://example.com/path"},
		{"no url", "no link here", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractURL(tc.text)
			if got != tc.want {
				t.Errorf("ExtractURL(%q) = %q, want %q", tc.text, got, tc.want)
			}
		})
	}
}
