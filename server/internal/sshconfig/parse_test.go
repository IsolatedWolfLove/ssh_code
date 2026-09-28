package sshconfig

import (
	"reflect"
	"testing"
)

// No ssh-config.test.ts was found alongside src/main/ssh-config.ts in this
// repo, so these fixtures are constructed directly against the confirmed
// behavior of parseSshConfig/buildInput/parseProxyJump/parsePort in
// ssh-config.ts (read in full before writing this port), rather than ported
// from an existing test file.

func TestParse_SimpleHostBlock(t *testing.T) {
	config := "Host foo\n  HostName example.com\n  Port 2222\n  User alice\n  IdentityFile ~/.ssh/id_rsa\n"

	got := Parse(config, "defaultuser", "/home/alice")

	want := []ImportedConnection{
		{
			DisplayName:      "foo",
			Host:             "example.com",
			Port:             2222,
			Username:         "alice",
			AuthMethod:       "privateKey",
			PrivateKeyPath:   "/home/alice/.ssh/id_rsa",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_DefaultsWhenDirectivesMissing(t *testing.T) {
	// No HostName -> host falls back to the alias itself. No User -> falls
	// back to defaultUsername. No Port -> defaults to 22. No IdentityFile ->
	// authMethod falls back to 'agent'.
	config := "Host bare\n"

	got := Parse(config, "defaultuser", "/home/defaultuser")

	want := []ImportedConnection{
		{
			DisplayName:      "bare",
			Host:             "bare",
			Port:             22,
			Username:         "defaultuser",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_WildcardAndNegatedAliasesSkipped(t *testing.T) {
	config := "Host *\n  User nobody\n\nHost bastion !excluded\n  HostName bastion.example.com\n\nHost host?\n  HostName weird.example.com\n"

	got := Parse(config, "defaultuser", "/home/defaultuser")

	// "*" is filtered out of its own Host line entirely (no aliases left ->
	// block is skipped). "bastion" survives (no glob chars); "!excluded" and
	// "host?" are filtered.
	want := []ImportedConnection{
		{
			DisplayName:      "bastion",
			Host:             "bastion.example.com",
			Port:             22,
			Username:         "defaultuser",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_MultipleHostBlocksAndAliasesOnOneLine(t *testing.T) {
	config := "Host web1 web2\n  HostName shared.example.com\n  User deploy\n"

	got := Parse(config, "defaultuser", "/home/defaultuser")

	want := []ImportedConnection{
		{
			DisplayName:      "web1",
			Host:             "shared.example.com",
			Port:             22,
			Username:         "deploy",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
		{
			DisplayName:      "web2",
			Host:             "shared.example.com",
			Port:             22,
			Username:         "deploy",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_CommentsAndBlankLinesIgnored(t *testing.T) {
	config := "# a comment\n\nHost foo # trailing comment\n  HostName example.com # another comment\n\n  User alice\n"

	got := Parse(config, "defaultuser", "/home/alice")

	want := []ImportedConnection{
		{
			DisplayName:      "foo",
			Host:             "example.com",
			Port:             22,
			Username:         "alice",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_ProxyJumpSimple(t *testing.T) {
	config := "Host target\n  HostName target.internal\n  User alice\n  ProxyJump bastion.example.com\n"

	got := Parse(config, "defaultuser", "/home/alice")

	if len(got) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(got))
	}
	jump := got[0].JumpHost
	if jump == nil {
		t.Fatalf("expected JumpHost to be set")
	}
	want := JumpHostInput{
		Host:       "bastion.example.com",
		Port:       22,
		Username:   "alice", // no explicit user@ prefix -> falls back to the target's username
		AuthMethod: "agent",
	}
	if *jump != want {
		t.Fatalf("JumpHost = %#v, want %#v", *jump, want)
	}
}

func TestParse_ProxyJumpWithUserAndPort(t *testing.T) {
	config := "Host target\n  HostName target.internal\n  User alice\n  ProxyJump bob@bastion.example.com:2200\n"

	got := Parse(config, "defaultuser", "/home/alice")

	jump := got[0].JumpHost
	if jump == nil {
		t.Fatalf("expected JumpHost to be set")
	}
	want := JumpHostInput{
		Host:       "bastion.example.com",
		Port:       2200,
		Username:   "bob",
		AuthMethod: "agent",
	}
	if *jump != want {
		t.Fatalf("JumpHost = %#v, want %#v", *jump, want)
	}
}

func TestParse_ProxyJumpMultiHopOrNoneIgnored(t *testing.T) {
	multiHop := "Host target\n  HostName target.internal\n  ProxyJump a.example.com,b.example.com\n"
	none := "Host target\n  HostName target.internal\n  ProxyJump none\n"

	for name, config := range map[string]string{"multi-hop": multiHop, "none": none} {
		t.Run(name, func(t *testing.T) {
			got := Parse(config, "defaultuser", "/home/defaultuser")
			if len(got) != 1 {
				t.Fatalf("expected 1 connection, got %d", len(got))
			}
			if got[0].JumpHost != nil {
				t.Fatalf("expected JumpHost to be nil for %q, got %#v", name, got[0].JumpHost)
			}
		})
	}
}

func TestParse_KnownHostsFileEnablesHostVerification(t *testing.T) {
	config := "Host foo\n  HostName example.com\n  UserKnownHostsFile ~/.ssh/known_hosts\n"

	got := Parse(config, "alice", "/home/alice")

	if len(got) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(got))
	}
	if got[0].HostVerification != "knownHosts" {
		t.Fatalf("HostVerification = %q, want knownHosts", got[0].HostVerification)
	}
	if got[0].KnownHostsPath != "/home/alice/.ssh/known_hosts" {
		t.Fatalf("KnownHostsPath = %q, want /home/alice/.ssh/known_hosts", got[0].KnownHostsPath)
	}
}

func TestParse_MatchLineResetsCurrentBlock(t *testing.T) {
	// After a "Match" line, directives are ignored until the next Host line
	// (current becomes nil), mirroring `if (key === 'match') { current =
	// null; continue; }` in the original.
	config := "Host foo\n  HostName example.com\nMatch host foo\n  User ignored-because-current-is-nil\n"

	got := Parse(config, "defaultuser", "/home/defaultuser")

	want := []ImportedConnection{
		{
			DisplayName:      "foo",
			Host:             "example.com",
			Port:             22,
			Username:         "defaultuser",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_HostWithNoAliasesLeftIsSkipped(t *testing.T) {
	// "Host *" alone has no non-glob aliases, so the block is dropped
	// entirely and its directives must not leak into anything after it.
	config := "Host *\n  User global-default\nHost real\n  HostName real.example.com\n"

	got := Parse(config, "defaultuser", "/home/defaultuser")

	// "real" is a fresh Host block; it does NOT inherit "User global-default"
	// because that directive was attached to the dropped "*" block's options,
	// not to globalOptions (Host lines snapshot globalOptions, not any
	// previous Host block's options).
	want := []ImportedConnection{
		{
			DisplayName:      "real",
			Host:             "real.example.com",
			Port:             22,
			Username:         "defaultuser",
			AuthMethod:       "agent",
			HostVerification: "off",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse() = %#v, want %#v", got, want)
	}
}

func TestParse_EmptyHostOrUsernameDropsEntry(t *testing.T) {
	// HostName explicitly blank cannot happen via parseDirective (empty
	// values are rejected there), but an alias plus an empty defaultUsername
	// with no explicit User directive should still drop the entry.
	config := "Host foo\n"

	got := Parse(config, "", "/home/x")

	if len(got) != 0 {
		t.Fatalf("expected no connections when username is empty, got %#v", got)
	}
}

func TestParsePort(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  int
	}{
		{"empty", "", 22},
		{"valid", "2222", 2222},
		{"zero", "0", 22},
		{"negative", "-1", 22},
		{"too large", "70000", 22},
		{"non numeric", "abc", 22},
		{"fractional", "22.5", 22},
		{"max valid", "65535", 65535},
		{"min valid", "1", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parsePort(tc.value); got != tc.want {
				t.Errorf("parsePort(%q) = %d, want %d", tc.value, got, tc.want)
			}
		})
	}
}

func TestExpandHome(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{"bare tilde", "~", "/home/alice"},
		{"tilde slash", "~/.ssh/id_rsa", "/home/alice/.ssh/id_rsa"},
		{"no tilde", "/etc/ssh/id_rsa", "/etc/ssh/id_rsa"},
		{"percent d token", "%d/.ssh/id_rsa", "/home/alice/.ssh/id_rsa"},
		{"percent h token", "/keys/%h", "/keys/example.com"},
		{"percent r token", "/keys/%r", "/keys/alice"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := expandHome(tc.value, "/home/alice", "example.com", "alice")
			if got != tc.want {
				t.Errorf("expandHome(%q) = %q, want %q", tc.value, got, tc.want)
			}
		})
	}
}

func TestStripComment(t *testing.T) {
	cases := []struct {
		name string
		line string
		want string
	}{
		{"no comment", "HostName example.com", "HostName example.com"},
		{"trailing comment", "HostName example.com # comment", "HostName example.com"},
		{"quoted hash preserved", `HostName "exam#ple.com"`, `HostName "exam#ple.com"`},
		{"hash at start", "# whole line comment", ""},
		{"empty line", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripComment(tc.line); got != tc.want {
				t.Errorf("stripComment(%q) = %q, want %q", tc.line, got, tc.want)
			}
		})
	}
}

func TestParseDirective(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantKey   string
		wantValue string
		wantOK    bool
	}{
		{"space separated", "HostName example.com", "hostname", "example.com", true},
		{"equals separated", "HostName=example.com", "hostname", "example.com", true},
		{"quoted value", `HostName "example.com"`, "hostname", "example.com", true},
		{"no separator", "HostName", "", "", false},
		{"empty value", "HostName    ", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, value, ok := parseDirective(tc.line)
			if ok != tc.wantOK || key != tc.wantKey || value != tc.wantValue {
				t.Errorf("parseDirective(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tc.line, key, value, ok, tc.wantKey, tc.wantValue, tc.wantOK)
			}
		})
	}
}
