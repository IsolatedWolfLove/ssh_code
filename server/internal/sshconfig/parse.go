// Package sshconfig parses OpenSSH client config files (~/.ssh/config) into
// a list of importable connections, replacing parseSshConfig in
// src/main/ssh-config.ts for the Wails backend. This package is pure text
// parsing: it does not read any file itself (the caller supplies the config
// file's text) and does not touch the saved-connections store (the caller
// is expected to hand the results to internal/store for persistence).
package sshconfig

import (
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// JumpHostInput mirrors the ConnectInput['jumpHost'] shape built by
// parseProxyJump in ssh-config.ts. Note: the original always sets
// authMethod to 'agent' and agentSocket to ” for a ProxyJump-derived jump
// host (even though an empty agent socket combined with 'agent' auth is not
// directly usable) — this looks like a quirk of the original rather than a
// deliberate design, but this port mirrors it exactly rather than "fixing"
// unspecified behavior.
type JumpHostInput struct {
	Host        string
	Port        int
	Username    string
	AuthMethod  string
	Password    string
	AgentSocket string
}

// ImportedConnection mirrors ImportedSshConnection in ssh-config.ts: a
// ConnectInput (see contracts.ts) plus a displayName taken from the Host
// alias.
type ImportedConnection struct {
	DisplayName      string
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

// sshOptions mirrors the SshOptions interface in ssh-config.ts: the subset
// of ssh_config(5) directives this importer recognizes. Only HostName,
// User, Port, IdentityFile, ProxyJump, and UserKnownHostsFile are handled;
// every other directive (Match, Compression, ForwardAgent, etc.) is parsed
// far enough to be skipped and otherwise ignored, confirmed from the
// original's explicit include-list check.
//
// A zero value (empty string) means "not set", mirroring the original's use
// of `undefined` — this is safe because parseDirective never produces an
// empty value for a recognized directive (empty values are rejected there),
// so there's no ambiguity between "not set" and "set to empty".
type sshOptions struct {
	hostName           string
	user               string
	port               string
	identityFile       string
	proxyJump          string
	userKnownHostsFile string
}

var (
	// separatorRe finds the first whitespace-or-'=' character in a
	// directive line, mirroring `line.search(/[\s=]/)`.
	separatorRe = regexp.MustCompile(`[ \t\n\r\f\v=]`)
	// directiveValueTrimRe strips a leading "<ws>*=<ws>*" or "<ws>+" run
	// from a directive's raw value slice, mirroring
	// `.replace(/^\s*=\s*|^\s+/, '')`.
	directiveValueTrimRe = regexp.MustCompile(`^[ \t\n\r\f\v]*=[ \t\n\r\f\v]*|^[ \t\n\r\f\v]+`)
	// quotedValueRe strips one layer of surrounding double quotes,
	// mirroring `.replace(/^"(.*)"$/, '$1')`.
	quotedValueRe = regexp.MustCompile(`^"(.*)"$`)
	// proxyJumpRe parses a single-hop ProxyJump value ("[user@]host[:port]",
	// with host optionally bracketed for IPv6), mirroring the regex in
	// parseProxyJump.
	proxyJumpRe = regexp.MustCompile(`^(?:(?P<user>[^@:\s]+)@)?(?P<host>\[[^\]]+\]|[^:\s]+)(?::(?P<port>\d+))?$`)
)

// stripComment removes a trailing '#' comment from line, honoring double
// quotes and a simple backslash-escape heuristic so a quoted or
// backslash-escaped '#' is not treated as a comment start. Mirrors
// stripComment in ssh-config.ts exactly, including its escape-parity
// quirks (it is a simple heuristic, not a full shell-quoting parser).
func stripComment(line string) string {
	var quoted, escaped bool
	var result strings.Builder

	for _, ch := range line {
		if ch == '"' && !escaped {
			quoted = !quoted
		}
		if ch == '#' && !quoted {
			break
		}
		result.WriteRune(ch)

		nextEscaped := ch == '\\' && !escaped
		if ch != '\\' {
			nextEscaped = false
		}
		escaped = nextEscaped
	}

	return strings.TrimSpace(result.String())
}

// parseDirective splits a comment-stripped config line into a lowercased
// key and its value, unwrapping one layer of surrounding double quotes.
// Returns ok=false for a line with no recognizable "key value"/"key=value"
// shape, or where either side is empty after trimming. Mirrors
// parseDirective in ssh-config.ts.
func parseDirective(line string) (key, value string, ok bool) {
	loc := separatorRe.FindStringIndex(line)
	if loc == nil {
		return "", "", false
	}

	sep := loc[0]
	key = strings.ToLower(strings.TrimSpace(line[:sep]))

	rest := directiveValueTrimRe.ReplaceAllString(line[sep:], "")
	rest = strings.TrimSpace(rest)
	rest = quotedValueRe.ReplaceAllString(rest, "$1")
	value = rest

	if key == "" || value == "" {
		return "", "", false
	}
	return key, value, true
}

// expandHome expands a leading "~" or "~/" in value against homeDirectory,
// and substitutes ssh_config's %d (home directory), %h (host), and %r
// (remote username) tokens elsewhere in the string. Mirrors expandHome in
// ssh-config.ts.
func expandHome(value, homeDirectory, host, username string) string {
	if value == "~" {
		return homeDirectory
	}
	if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
		return filepath.Join(homeDirectory, value[2:])
	}

	result := strings.ReplaceAll(value, "%d", homeDirectory)
	result = strings.ReplaceAll(result, "%h", host)
	result = strings.ReplaceAll(result, "%r", username)
	return result
}

// parsePort parses an OpenSSH Port directive's value, defaulting to 22 for
// anything that is not a plain integer in [1, 65535] (missing, empty,
// non-numeric, fractional, or out of range). Mirrors parsePort in
// ssh-config.ts (Number(value) + Number.isInteger + range check).
func parsePort(value string) int {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 22
	}

	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 22
	}
	if parsed != float64(int64(parsed)) {
		return 22
	}

	port := int64(parsed)
	if port < 1 || port > 65535 {
		return 22
	}
	return int(port)
}

// parseProxyJump parses a single-hop ProxyJump directive value into a
// JumpHostInput, or returns nil for a multi-hop ("a,b"), "none", empty, or
// unparseable value (multi-hop jump chains are out of scope, matching the
// original). Mirrors parseProxyJump in ssh-config.ts.
func parseProxyJump(value, username string) *JumpHostInput {
	if value == "" || strings.Contains(value, ",") || strings.EqualFold(value, "none") {
		return nil
	}

	match := proxyJumpRe.FindStringSubmatch(value)
	if match == nil {
		return nil
	}

	groups := make(map[string]string, len(proxyJumpRe.SubexpNames()))
	for i, name := range proxyJumpRe.SubexpNames() {
		if name != "" && i < len(match) {
			groups[name] = match[i]
		}
	}

	host := groups["host"]
	if host == "" {
		return nil
	}
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")

	jumpUsername := groups["user"]
	if jumpUsername == "" {
		jumpUsername = username
	}

	return &JumpHostInput{
		Host:        host,
		Port:        parsePort(groups["port"]),
		Username:    jumpUsername,
		AuthMethod:  "agent",
		Password:    "",
		AgentSocket: "",
	}
}

// filterAliases drops any Host-line alias containing a glob/negation
// character ('*', '!', '?'), mirroring
// `value.split(/\s+/).filter((alias) => !/[*!?]/.test(alias))` — pattern
// aliases like "Host *" or "Host !excluded" are not concrete, importable
// hosts.
func filterAliases(fields []string) []string {
	out := make([]string, 0, len(fields))
	for _, alias := range fields {
		if strings.ContainsAny(alias, "*!?") {
			continue
		}
		out = append(out, alias)
	}
	return out
}

// splitLines splits configText on line boundaries, treating a lone '\r'
// (not followed by '\n') as ordinary content rather than a line break —
// mirrors `config.split(/\r?\n/)` exactly (CRLF and LF are both line
// breaks; a bare CR is not).
func splitLines(configText string) []string {
	normalized := strings.ReplaceAll(configText, "\r\n", "\n")
	return strings.Split(normalized, "\n")
}

// buildInput turns one Host alias plus its accumulated options into an
// ImportedConnection, or nil if it has no usable host or username. Mirrors
// buildInput in ssh-config.ts.
func buildInput(alias string, options sshOptions, defaultUsername, homeDirectory string) *ImportedConnection {
	host := options.hostName
	if host == "" {
		host = alias
	}
	host = strings.TrimSpace(host)

	username := options.user
	if username == "" {
		username = defaultUsername
	}
	username = strings.TrimSpace(username)

	if host == "" || username == "" {
		return nil
	}

	privateKeyPath := ""
	if options.identityFile != "" {
		if fields := strings.Fields(options.identityFile); len(fields) > 0 {
			privateKeyPath = expandHome(fields[0], homeDirectory, host, username)
		}
	}

	knownHostsPath := ""
	if options.userKnownHostsFile != "" {
		if fields := strings.Fields(options.userKnownHostsFile); len(fields) > 0 {
			knownHostsPath = expandHome(fields[0], homeDirectory, host, username)
		}
	}

	authMethod := "agent"
	if privateKeyPath != "" {
		authMethod = "privateKey"
	}

	hostVerification := "off"
	if knownHostsPath != "" {
		hostVerification = "knownHosts"
	}

	return &ImportedConnection{
		DisplayName:      alias,
		Host:             host,
		Port:             parsePort(options.port),
		Username:         username,
		AuthMethod:       authMethod,
		Password:         "",
		PrivateKeyPath:   privateKeyPath,
		Passphrase:       "",
		AgentSocket:      "",
		HostVerification: hostVerification,
		KnownHostsPath:   knownHostsPath,
		JumpHost:         parseProxyJump(options.proxyJump, username),
	}
}

// Parse parses the text of an OpenSSH client config file into a list of
// importable connections, one per unique Host alias (in first-seen order,
// with a later block's directives overriding an earlier same-alias block's,
// same as ssh-config.ts's Map-based dedup). defaultUsername is used for any
// host with no explicit User directive; homeDirectory is used to expand "~"
// in IdentityFile/UserKnownHostsFile paths and ssh_config's %d token.
//
// Mirrors parseSshConfig in ssh-config.ts. Recognized directives: Host,
// HostName, User, Port, IdentityFile, ProxyJump, UserKnownHostsFile. A
// "Match" line (unsupported) resets the current block to nil, so directives
// until the next Host line are ignored. Directives before the first Host
// line become defaults inherited by every subsequent Host block created
// after them (a plain copy taken at the moment each Host line is parsed,
// not a live reference) — later top-of-file directives do not retroactively
// affect Host blocks already started. Any other directive is ignored.
func Parse(configText, defaultUsername, homeDirectory string) []ImportedConnection {
	globalOptions := sshOptions{}

	type hostBlock struct {
		aliases []string
		options *sshOptions
	}
	var hosts []hostBlock
	current := &globalOptions

	for _, rawLine := range splitLines(configText) {
		key, value, ok := parseDirective(stripComment(rawLine))
		if !ok {
			continue
		}

		if key == "match" {
			current = nil
			continue
		}

		if key == "host" {
			aliases := filterAliases(strings.Fields(value))
			if len(aliases) == 0 {
				current = nil
				continue
			}
			opts := globalOptions // snapshot at this point, not a live reference
			hosts = append(hosts, hostBlock{aliases: aliases, options: &opts})
			current = &opts
			continue
		}

		if current == nil {
			continue
		}

		switch key {
		case "hostname":
			if current.hostName == "" {
				current.hostName = value
			}
		case "user":
			if current.user == "" {
				current.user = value
			}
		case "port":
			if current.port == "" {
				current.port = value
			}
		case "identityfile":
			if current.identityFile == "" {
				current.identityFile = value
			}
		case "proxyjump":
			if current.proxyJump == "" {
				current.proxyJump = value
			}
		case "userknownhostsfile":
			if current.userKnownHostsFile == "" {
				current.userKnownHostsFile = value
			}
		}
	}

	order := make([]string, 0)
	byAlias := make(map[string]ImportedConnection)
	for _, block := range hosts {
		for _, alias := range block.aliases {
			input := buildInput(alias, *block.options, defaultUsername, homeDirectory)
			if input == nil {
				continue
			}
			if _, exists := byAlias[alias]; !exists {
				order = append(order, alias)
			}
			byAlias[alias] = *input
		}
	}

	result := make([]ImportedConnection, 0, len(order))
	for _, alias := range order {
		result = append(result, byAlias[alias])
	}
	return result
}
