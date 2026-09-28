package ssh

import "testing"

func TestHostMatchesPattern(t *testing.T) {
	cases := []struct {
		name    string
		host    string
		port    int
		pattern string
		want    bool
	}{
		{"exact host, default port ignored", "example.com", 22, "example.com", true},
		{"bracketed host:port", "example.com", 2222, "[example.com]:2222", true},
		{"bracketed mismatch on port", "example.com", 22, "[example.com]:2222", false},
		{"wildcard suffix", "host.example.com", 22, "*.example.com", true},
		{"wildcard no match", "host.example.org", 22, "*.example.com", false},
		{"question mark glob", "host1.example.com", 22, "host?.example.com", true},
		{"plain mismatch", "example.com", 22, "other.com", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := HostMatchesPattern(tc.host, tc.port, tc.pattern)
			if got != tc.want {
				t.Errorf("HostMatchesPattern(%q, %d, %q) = %v, want %v", tc.host, tc.port, tc.pattern, got, tc.want)
			}
		})
	}
}

func TestParseKnownHostsLine(t *testing.T) {
	// A syntactically valid (if not cryptographically meaningful) base64 blob.
	const keyB64 = "dGVzdC1rZXktZGF0YS0xMjM0"

	cases := []struct {
		name    string
		line    string
		wantNil bool
	}{
		{"comment line", "# this is a comment", true},
		{"hashed entry marker", "|1|abc|def ssh-ed25519 " + keyB64, true},
		{"blank line", "   ", true},
		{"valid entry", "example.com,192.0.2.1 ssh-ed25519 " + keyB64, false},
		{"missing fields", "example.com ssh-ed25519", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseKnownHostsLine(tc.line)
			if tc.wantNil && got != nil {
				t.Errorf("parseKnownHostsLine(%q) = %+v, want nil", tc.line, got)
			}
			if !tc.wantNil && got == nil {
				t.Errorf("parseKnownHostsLine(%q) = nil, want non-nil", tc.line)
			}
		})
	}

	record := parseKnownHostsLine("example.com,192.0.2.1 ssh-ed25519 " + keyB64)
	if record == nil {
		t.Fatal("expected a parsed record")
	}
	if record.keyType != "ssh-ed25519" {
		t.Errorf("keyType = %q, want ssh-ed25519", record.keyType)
	}
	if len(record.hosts) != 2 || record.hosts[0] != "example.com" || record.hosts[1] != "192.0.2.1" {
		t.Errorf("hosts = %v, want [example.com 192.0.2.1]", record.hosts)
	}
}
