package sftp

import (
	"errors"
	"strings"
	"testing"
)

func TestBuildRipgrepSearchCommand(t *testing.T) {
	tests := []struct {
		name  string
		input SearchInput
		want  string
	}{
		{
			name: "case insensitive default",
			input: SearchInput{
				RootPath: "/home/user/project",
				Query:    "needle",
			},
			want: "rg --json --line-number --column --fixed-strings --hidden --no-ignore --no-messages --glob '!.git' --glob '!**/.git/**' --ignore-case -- 'needle' '/home/user/project'",
		},
		{
			name: "case sensitive",
			input: SearchInput{
				RootPath:      "/srv",
				Query:         "Needle",
				CaseSensitive: true,
			},
			want: "rg --json --line-number --column --fixed-strings --hidden --no-ignore --no-messages --glob '!.git' --glob '!**/.git/**' -- 'Needle' '/srv'",
		},
		{
			name: "query with single quote is escaped",
			input: SearchInput{
				RootPath: "/srv",
				Query:    "it's",
			},
			want: "rg --json --line-number --column --fixed-strings --hidden --no-ignore --no-messages --glob '!.git' --glob '!**/.git/**' --ignore-case -- 'it'\\''s' '/srv'",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRipgrepSearchCommand(tt.input)
			if got != tt.want {
				t.Errorf("buildRipgrepSearchCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSearchWithRipgrep_SingleMatch(t *testing.T) {
	line := `{"type":"match","data":{"path":{"text":"main.go"},"lines":{"text":"func main() {\n"},"line_number":10,"submatches":[{"start":5,"end":9}]}}`
	exec := func(command string) (string, string, int, error) {
		return line + "\n", "", 0, nil
	}

	result, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "main"})
	if err != nil {
		t.Fatalf("SearchWithRipgrep() error = %v", err)
	}
	if len(result.Matches) != 1 {
		t.Fatalf("got %d matches, want 1", len(result.Matches))
	}
	m := result.Matches[0]
	if m.Path != "/proj/main.go" || m.Line != 10 || m.Column != 6 {
		t.Errorf("match = %+v, want Path=/proj/main.go Line=10 Column=6", m)
	}
	if result.Truncated {
		t.Error("Truncated = true, want false")
	}
}

func TestSearchWithRipgrep_MultipleSubmatchesOneLine(t *testing.T) {
	line := `{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"foo foo foo\n"},"line_number":1,"submatches":[{"start":0,"end":3},{"start":4,"end":7},{"start":8,"end":11}]}}`
	exec := func(command string) (string, string, int, error) {
		return line + "\n", "", 0, nil
	}

	result, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "foo"})
	if err != nil {
		t.Fatalf("SearchWithRipgrep() error = %v", err)
	}
	if len(result.Matches) != 3 {
		t.Fatalf("got %d matches, want 3", len(result.Matches))
	}
	wantColumns := []int{1, 5, 9}
	for i, m := range result.Matches {
		if m.Column != wantColumns[i] {
			t.Errorf("match[%d].Column = %d, want %d", i, m.Column, wantColumns[i])
		}
	}
}

func TestSearchWithRipgrep_AbsolutePathNotRejoined(t *testing.T) {
	line := `{"type":"match","data":{"path":{"text":"/abs/other.txt"},"lines":{"text":"needle\n"},"line_number":1,"submatches":[{"start":0,"end":6}]}}`
	exec := func(command string) (string, string, int, error) {
		return line + "\n", "", 0, nil
	}

	result, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "needle"})
	if err != nil {
		t.Fatalf("SearchWithRipgrep() error = %v", err)
	}
	if len(result.Matches) != 1 || result.Matches[0].Path != "/abs/other.txt" {
		t.Fatalf("got matches = %+v, want single match at /abs/other.txt", result.Matches)
	}
}

func TestSearchWithRipgrep_PreviewTruncatesLongLine(t *testing.T) {
	longPrefix := strings.Repeat("x", 100)
	lineText := longPrefix + "needle" + strings.Repeat("y", 100)
	payload := `{"type":"match","data":{"path":{"text":"big.txt"},"lines":{"text":"` + lineText + `\n"},"line_number":1,"submatches":[{"start":100,"end":106}]}}`
	exec := func(command string) (string, string, int, error) {
		return payload + "\n", "", 0, nil
	}

	result, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "needle"})
	if err != nil {
		t.Fatalf("SearchWithRipgrep() error = %v", err)
	}
	if len(result.Matches) != 1 {
		t.Fatalf("got %d matches, want 1", len(result.Matches))
	}
	preview := result.Matches[0].Preview
	if len(preview) >= len(lineText) {
		t.Errorf("preview not truncated: len=%d, full line len=%d", len(preview), len(lineText))
	}
	if !strings.Contains(preview, "needle") {
		t.Errorf("preview %q does not contain the match", preview)
	}
}

func TestSearchWithRipgrep_MaxResultsTruncates(t *testing.T) {
	var lines []string
	for i := 0; i < 5; i++ {
		lines = append(lines, `{"type":"match","data":{"path":{"text":"f.txt"},"lines":{"text":"needle\n"},"line_number":1,"submatches":[{"start":0,"end":6}]}}`)
	}
	exec := func(command string) (string, string, int, error) {
		return strings.Join(lines, "\n"), "", 0, nil
	}

	result, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "needle", MaxResults: 2})
	if err != nil {
		t.Fatalf("SearchWithRipgrep() error = %v", err)
	}
	if len(result.Matches) != 2 {
		t.Fatalf("got %d matches, want 2 (capped)", len(result.Matches))
	}
	if !result.Truncated {
		t.Error("Truncated = false, want true")
	}
}

func TestSearchWithRipgrep_NonJSONLineIsFallback(t *testing.T) {
	exec := func(command string) (string, string, int, error) {
		return "not json at all\n", "", 0, nil
	}

	_, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "needle"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !IsFallbackError(err) {
		t.Errorf("expected fallback error, got %v", err)
	}
}

func TestSearchWithRipgrep_ExitCodeClassification(t *testing.T) {
	tests := []struct {
		name         string
		stdout       string
		stderr       string
		exitCode     int
		wantFallback bool
		wantErr      bool
	}{
		{
			name:     "exit 0 no matches",
			exitCode: 0,
		},
		{
			name:     "exit 1 no matches found is not an error",
			exitCode: 1,
		},
		{
			name:         "exit 127 command not found",
			exitCode:     127,
			stderr:       "",
			wantFallback: true,
			wantErr:      true,
		},
		{
			name:         "stderr says command not found",
			exitCode:     126,
			stderr:       "bash: rg: command not found",
			wantFallback: true,
			wantErr:      true,
		},
		{
			name:         "unrecognized flag on old rg",
			exitCode:     2,
			stderr:       "error: Found argument '--json' which wasn't expected, or unrecognized flag",
			wantFallback: true,
			wantErr:      true,
		},
		{
			name:     "permission denied is a hard error, not a fallback",
			exitCode: 2,
			stderr:   "rg: /root/secret: Permission denied (os error 13)",
			wantErr:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exec := func(command string) (string, string, int, error) {
				return tt.stdout, tt.stderr, tt.exitCode, nil
			}
			_, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "needle"})
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			if tt.wantErr && IsFallbackError(err) != tt.wantFallback {
				t.Errorf("IsFallbackError() = %v, want %v (err: %v)", IsFallbackError(err), tt.wantFallback, err)
			}
		})
	}
}

func TestSearchWithRipgrep_ExecStartFailureIsFallback(t *testing.T) {
	exec := func(command string) (string, string, int, error) {
		return "", "", 0, errors.New("simulated exec failure")
	}
	_, err := SearchWithRipgrep(exec, SearchInput{RootPath: "/proj", Query: "needle"})
	if !IsFallbackError(err) {
		t.Errorf("expected fallback error when exec itself fails to start, got %v", err)
	}
}

func TestBuildSearchPreview(t *testing.T) {
	tests := []struct {
		name        string
		lineText    string
		startIndex  int
		matchLength int
		want        string
	}{
		{
			name:        "short line returned as-is (trimmed)",
			lineText:    "  hello needle world  ",
			startIndex:  8,
			matchLength: 6,
			want:        "hello needle world",
		},
		{
			// startIndex is clamped to len(lineText) first, so the preview
			// window ends up covering the tail of the line rather than being
			// empty.
			name:        "out of range start is clamped to end of line",
			lineText:    "short",
			startIndex:  100,
			matchLength: 5,
			want:        "short",
		},
		{
			name:        "negative start clamped to zero",
			lineText:    "hello",
			startIndex:  -5,
			matchLength: 5,
			want:        "hello",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildSearchPreview(tt.lineText, tt.startIndex, tt.matchLength)
			if got != tt.want {
				t.Errorf("buildSearchPreview() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestQuoteForShell(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"simple", "'simple'"},
		{"it's", `'it'\''s'`},
		{"", "''"},
	}
	for _, tt := range tests {
		if got := quoteForShell(tt.in); got != tt.want {
			t.Errorf("quoteForShell(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestCompileLiteralQuery(t *testing.T) {
	re, err := compileLiteralQuery("a.b*c", false)
	if err != nil {
		t.Fatalf("compileLiteralQuery() error = %v", err)
	}
	// The query contains regex metacharacters that must be treated literally.
	if re.MatchString("axbyc") {
		t.Error("literal query treated '.' and '*' as regex metacharacters")
	}
	if !re.MatchString("A.B*C") {
		t.Error("case-insensitive match failed")
	}

	reSensitive, err := compileLiteralQuery("Needle", true)
	if err != nil {
		t.Fatalf("compileLiteralQuery() error = %v", err)
	}
	if reSensitive.MatchString("needle") {
		t.Error("case-sensitive query unexpectedly matched different case")
	}
	if !reSensitive.MatchString("Needle") {
		t.Error("case-sensitive query failed to match exact case")
	}
}
