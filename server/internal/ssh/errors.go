package ssh

import (
	"regexp"
	"strings"
)

// DiagnosticCode mirrors contracts.ts's ConnectionDiagnosticCode union.
type DiagnosticCode string

const (
	DiagnosticWrongPassword        DiagnosticCode = "wrongPassword"
	DiagnosticHostUnreachable      DiagnosticCode = "hostUnreachable"
	DiagnosticKnownHosts           DiagnosticCode = "knownHosts"
	DiagnosticPrivateKey           DiagnosticCode = "privateKey"
	DiagnosticAuthenticationFailed DiagnosticCode = "authenticationFailed"
	DiagnosticUnknown              DiagnosticCode = "unknown"
)

// Diagnostic mirrors the ConnectionDiagnostic shape produced by
// classifyConnectionError in ssh-session.ts.
type Diagnostic struct {
	Code         DiagnosticCode
	Message      string
	RecoveryHint string
	Recoverable  bool
}

var urlPattern = regexp.MustCompile(`https?://\S+`)

// ExtractURL mirrors extractUrl in ssh-session.ts: finds the first URL in
// text (used to surface Tailscale SSH login links), trimming trailing
// punctuation that is very likely not part of the URL.
func ExtractURL(text string) string {
	match := urlPattern.FindString(text)
	if match == "" {
		return ""
	}
	return strings.TrimRight(match, "),.;")
}

// ClassifyConnectionError mirrors classifyConnectionError in ssh-session.ts:
// maps a raw error message to a diagnostic category the UI can act on.
func ClassifyConnectionError(err error) Diagnostic {
	message := "Unable to connect to the remote host"
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	lower := strings.ToLower(message)

	if strings.Contains(lower, "all configured authentication methods failed") ||
		strings.Contains(lower, "permission denied") ||
		strings.Contains(lower, "auth fail") ||
		strings.Contains(lower, "authentication failed") {
		wrongPassword := strings.Contains(lower, "password")
		if wrongPassword {
			return Diagnostic{
				Code:         DiagnosticWrongPassword,
				Message:      "Password authentication failed",
				RecoveryHint: "Check the password and username.",
				Recoverable:  true,
			}
		}
		return Diagnostic{
			Code:         DiagnosticAuthenticationFailed,
			Message:      "SSH authentication failed",
			RecoveryHint: "Check the selected authentication method and credentials.",
			Recoverable:  true,
		}
	}

	if strings.Contains(lower, "host verification failed") ||
		strings.Contains(lower, "host key") ||
		strings.Contains(lower, "known_hosts") ||
		strings.Contains(lower, "fingerprint") {
		return Diagnostic{
			Code:         DiagnosticKnownHosts,
			Message:      "Host verification failed",
			RecoveryHint: "Check the known_hosts path or update the host key entry.",
			Recoverable:  true,
		}
	}

	if strings.Contains(lower, "private key") ||
		strings.Contains(lower, "passphrase") ||
		strings.Contains(lower, "agent socket is required") ||
		strings.Contains(lower, "cannot parse privatekey") {
		return Diagnostic{
			Code:         DiagnosticPrivateKey,
			Message:      "Private key authentication failed",
			RecoveryHint: "Check the key path, key format, and passphrase.",
			Recoverable:  true,
		}
	}

	if strings.Contains(lower, "timed out") ||
		strings.Contains(lower, "ehostunreach") ||
		strings.Contains(lower, "enotfound") ||
		strings.Contains(lower, "econnrefused") ||
		strings.Contains(lower, "econnreset") ||
		strings.Contains(lower, "network is unreachable") ||
		strings.Contains(lower, "no route to host") {
		if strings.Contains(lower, "timed out") && strings.Contains(lower, "handshake") {
			return Diagnostic{
				Code:         DiagnosticAuthenticationFailed,
				Message:      "Timed out while waiting for Tailscale SSH verification",
				RecoveryHint: "Open the login link and complete the browser check before the timeout expires.",
				Recoverable:  true,
			}
		}
		return Diagnostic{
			Code:         DiagnosticHostUnreachable,
			Message:      "Host unreachable",
			RecoveryHint: "Check the host, port, network path, and whether SSH is listening.",
			Recoverable:  true,
		}
	}

	return Diagnostic{
		Code:         DiagnosticUnknown,
		Message:      message,
		RecoveryHint: "Check the connection settings and SSH server logs.",
		Recoverable:  true,
	}
}
