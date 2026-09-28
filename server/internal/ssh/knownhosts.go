package ssh

import (
	"encoding/base64"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// knownHostsRecord is a single parsed line of a known_hosts file.
type knownHostsRecord struct {
	hosts   []string
	keyType string
	keyData []byte
}

// parseKnownHostsLine mirrors parseKnownHostsLine in ssh-session.ts.
func parseKnownHostsLine(line string) *knownHostsRecord {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "|") {
		return nil
	}

	fields := splitWhitespace(trimmed, 3)
	if len(fields) < 3 {
		return nil
	}
	hostField, keyType, keyValue := fields[0], fields[1], fields[2]
	if hostField == "" || keyType == "" || keyValue == "" {
		return nil
	}

	// keyValue may have trailing comment fields; only the first token is the
	// base64 key body.
	keyToken := strings.Fields(keyValue)
	if len(keyToken) == 0 {
		return nil
	}

	keyData, err := base64.StdEncoding.DecodeString(keyToken[0])
	if err != nil {
		return nil
	}

	return &knownHostsRecord{
		hosts:   strings.Split(hostField, ","),
		keyType: keyType,
		keyData: keyData,
	}
}

var whitespaceRun = regexp.MustCompile(`\s+`)

// splitWhitespace splits on runs of whitespace, at most n fields (mirrors
// JS String.split(/\s+/, n) semantics closely enough for known_hosts lines).
func splitWhitespace(s string, n int) []string {
	return whitespaceRun.Split(strings.TrimSpace(s), n)
}

var globSpecialChars = regexp.MustCompile(`[.+^${}()|\[\]\\]`)

// HostMatchesPattern mirrors hostMatchesPattern in ssh-session.ts: matches a
// known_hosts host pattern (which may use * and ? globs, or a
// [host]:port-bracketed form) against the actual host/port pair.
func HostMatchesPattern(host string, port int, pattern string) bool {
	bracketed := fmt.Sprintf("[%s]:%d", host, port)
	if pattern == host || pattern == bracketed {
		return true
	}

	if strings.ContainsAny(pattern, "*?") {
		escaped := globSpecialChars.ReplaceAllStringFunc(pattern, func(m string) string {
			return "\\" + m
		})
		escaped = strings.ReplaceAll(escaped, "*", ".*")
		escaped = strings.ReplaceAll(escaped, "?", ".")
		re, err := regexp.Compile("^" + escaped + "$")
		if err != nil {
			return false
		}
		return re.MatchString(host) || re.MatchString(bracketed)
	}

	return false
}

// VerifyKnownHosts mirrors verifyKnownHosts in ssh-session.ts: checks whether
// remoteKeyType/remoteKeyData for host:port appears in the known_hosts file
// at knownHostsPath.
func VerifyKnownHosts(host string, port int, remoteKeyType string, remoteKeyData []byte, knownHostsPath string) (bool, error) {
	content, err := os.ReadFile(knownHostsPath)
	if err != nil {
		return false, err
	}

	lines := strings.Split(string(content), "\n")
	for _, line := range lines {
		record := parseKnownHostsLine(strings.TrimRight(line, "\r"))
		if record == nil || record.keyType != remoteKeyType {
			continue
		}

		matched := false
		for _, pattern := range record.hosts {
			if HostMatchesPattern(host, port, pattern) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}

		if bytesEqual(record.keyData, remoteKeyData) {
			return true, nil
		}
	}

	return false, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
