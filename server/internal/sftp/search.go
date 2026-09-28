package sftp

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
)

// DefaultSearchResultLimit mirrors DEFAULT_SEARCH_RESULT_LIMIT in
// ssh-session.ts.
const DefaultSearchResultLimit = 200

// SearchInput mirrors contracts.ts's SearchRemoteFilesInput.
type SearchInput struct {
	RootPath      string `json:"rootPath"`
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	// MaxResults <= 0 means "unset"; callers get DefaultSearchResultLimit.
	MaxResults int `json:"maxResults"`
}

// SearchMatch mirrors contracts.ts's SearchRemoteMatch.
type SearchMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Preview string `json:"preview"`
}

// SearchResult mirrors contracts.ts's SearchRemoteFilesResult.
type SearchResult struct {
	Query     string        `json:"query"`
	Matches   []SearchMatch `json:"matches"`
	Truncated bool          `json:"truncated"`
}

// ExecFunc runs command on the remote host over an SSH exec channel and
// returns its full output. This package has no dependency on internal/ssh
// (kept import-graph-free from that package); app.go supplies this by
// wrapping internal/ssh.Session.ExecRemoteCommand.
//
// Design note (synchronous vs. streaming): ssh-session.ts's
// searchInFilesWithRipgrep processes ripgrep's JSON-lines output
// incrementally and can send SIGTERM to the remote process the instant
// enough matches are found - an early-exit optimization that keeps huge
// result sets from making ripgrep scan an entire large tree needlessly. A
// synchronous "run command, get full output back" signature cannot
// replicate that: ripgrep always runs to completion on the remote host
// before this package sees any output, and truncation only discards extra
// matches after the fact. This trades a slower worst case (very large match
// counts on very large trees) for a much simpler contract. If that turns out
// to matter, upgrading ExecFunc to a streaming shape (a per-line callback
// plus a cancel function) is the fix, without needing to change anything
// else in this file.
type ExecFunc func(command string) (stdout string, stderr string, exitCode int, err error)

// fallbackError signals that ripgrep is unavailable/unusable on the remote
// host and the caller should retry with SearchByScanning. Mirrors
// createSearchFallbackError/isSearchFallbackError's {code: 'SEARCH_FALLBACK'}
// marker in ssh-session.ts. Kept unexported with a constructor + predicate,
// matching this package's existing canceledError/IsCanceled convention in
// transfer.go.
type fallbackError struct{ msg string }

func (e *fallbackError) Error() string { return e.msg }

func newFallbackError(format string, args ...interface{}) error {
	return &fallbackError{msg: fmt.Sprintf(format, args...)}
}

// IsFallbackError reports whether err signals "ripgrep isn't usable here,
// fall back to scanning" rather than a hard failure.
func IsFallbackError(err error) bool {
	_, ok := err.(*fallbackError)
	return ok
}

// SearchInFiles mirrors searchInFiles in ssh-session.ts: trims/validates
// input, tries ripgrep first, and falls back to a pure-SFTP scan when
// ripgrep is unavailable. Any other ripgrep failure is a hard error.
func SearchInFiles(client FileSystem, exec ExecFunc, input SearchInput) (SearchResult, error) {
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return SearchResult{Query: query, Matches: []SearchMatch{}, Truncated: false}, nil
	}

	rootPath := strings.TrimSpace(input.RootPath)
	if rootPath == "" {
		rootPath = "/"
	}

	normalized := SearchInput{
		RootPath:      rootPath,
		Query:         query,
		CaseSensitive: input.CaseSensitive,
		MaxResults:    input.MaxResults,
	}

	result, err := SearchWithRipgrep(exec, normalized)
	if err == nil {
		return result, nil
	}
	if !IsFallbackError(err) {
		return SearchResult{}, fmt.Errorf("unable to search in %s: %w", rootPath, err)
	}

	return SearchByScanning(client, normalized)
}

// --- ripgrep path -----------------------------------------------------------

// rgSubmatch mirrors one entry of a ripgrep --json match's data.submatches.
type rgSubmatch struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// rgMatchPayload mirrors the subset of ripgrep --json's per-line payload
// shape that searchInFilesWithRipgrep reads (data.path.text,
// data.lines.text, data.line_number, data.submatches).
type rgMatchPayload struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int          `json:"line_number"`
		Submatches []rgSubmatch `json:"submatches"`
	} `json:"data"`
}

// rgUnavailablePattern mirrors the /command not found|not found|unknown
// option|unrecognized flag|invalid option/i test in
// searchInFilesWithRipgrep's close handler.
var rgUnavailablePattern = regexp.MustCompile(`(?i)command not found|not found|unknown option|unrecognized flag|invalid option`)

// SearchWithRipgrep runs `rg --json` on the remote host via exec and parses
// its JSON-lines output into a SearchResult. Mirrors
// searchInFilesWithRipgrep. Returns a fallback error (see IsFallbackError)
// when ripgrep is unavailable/unusable on the remote host (exit 127, a
// command-not-found-shaped stderr, or output that isn't valid JSON); any
// other failure is a hard error.
func SearchWithRipgrep(exec ExecFunc, input SearchInput) (SearchResult, error) {
	maxResults := input.MaxResults
	if maxResults <= 0 {
		maxResults = DefaultSearchResultLimit
	}

	command := buildRipgrepSearchCommand(input)
	stdout, stderr, exitCode, err := exec(command)
	if err != nil {
		return SearchResult{}, newFallbackError("Unable to start ripgrep: %v", err)
	}

	var matches []SearchMatch
	truncated := false

	for _, rawLine := range strings.Split(stdout, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}

		var payload rgMatchPayload
		if jsonErr := json.Unmarshal([]byte(line), &payload); jsonErr != nil {
			return SearchResult{}, newFallbackError("Remote ripgrep does not support JSON output")
		}
		if payload.Type != "match" {
			continue
		}

		relativePath := payload.Data.Path.Text
		if relativePath == "" {
			continue
		}
		remotePath := relativePath
		if !strings.HasPrefix(relativePath, "/") {
			remotePath = path.Join(input.RootPath, relativePath)
		}

		lineText := strings.TrimRight(payload.Data.Lines.Text, "\r\n")
		lineNumber := payload.Data.LineNumber
		if lineNumber == 0 {
			lineNumber = 1
		}

		submatches := payload.Data.Submatches
		if len(submatches) == 0 {
			submatches = []rgSubmatch{{Start: 0, End: len(input.Query)}}
		}

		for _, sub := range submatches {
			matchLength := sub.End - sub.Start
			if matchLength < 1 {
				matchLength = 1
			}
			matches = append(matches, SearchMatch{
				Path:    remotePath,
				Line:    lineNumber,
				Column:  sub.Start + 1,
				Preview: buildSearchPreview(lineText, sub.Start, matchLength),
			})

			if len(matches) >= maxResults {
				truncated = true
				break
			}
		}
		if truncated {
			break
		}
	}

	if truncated {
		return SearchResult{Query: input.Query, Matches: matches, Truncated: true}, nil
	}

	trimmedStderr := strings.TrimSpace(stderr)
	if exitCode == 0 || exitCode == 1 || (len(matches) > 0 && trimmedStderr == "") {
		return SearchResult{Query: input.Query, Matches: matches, Truncated: false}, nil
	}

	if exitCode == 127 || rgUnavailablePattern.MatchString(trimmedStderr) {
		if trimmedStderr == "" {
			trimmedStderr = "ripgrep is unavailable on the remote host"
		}
		return SearchResult{}, newFallbackError("%s", trimmedStderr)
	}

	if trimmedStderr == "" {
		trimmedStderr = fmt.Sprintf("ripgrep exited with code %d", exitCode)
	}
	return SearchResult{}, errors.New(trimmedStderr)
}

// buildRipgrepSearchCommand mirrors buildRipgrepSearchCommand in
// ssh-session.ts exactly: same flags, same glob excludes, same
// case-sensitivity toggle, same quoting.
func buildRipgrepSearchCommand(input SearchInput) string {
	parts := []string{
		"rg", "--json", "--line-number", "--column", "--fixed-strings",
		"--hidden", "--no-ignore", "--no-messages",
		"--glob", quoteForShell("!.git"),
		"--glob", quoteForShell("!**/.git/**"),
	}

	if !input.CaseSensitive {
		parts = append(parts, "--ignore-case")
	}

	parts = append(parts, "--", quoteForShell(input.Query), quoteForShell(input.RootPath))
	return strings.Join(parts, " ")
}

// quoteForShell mirrors quoteForShell in shell.ts: single-quotes value,
// escaping embedded single quotes the same way ('\”).
func quoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// buildSearchPreview mirrors buildSearchPreview in ssh-session.ts: a
// trimmed window of +/-48 characters around the match. Unlike the
// JS original (which indexes lineText by UTF-16 code unit, ripgrep's own
// column/submatch offsets are byte offsets into the line), this indexes by
// byte, which is actually the more correct pairing for ripgrep-sourced
// matches; SearchByScanning's own matches are also byte-offset-consistent
// end to end, so there is no mismatch introduced either way. Bounds are
// clamped defensively since Go slicing panics on out-of-range indices where
// JS's String.slice silently clamps.
func buildSearchPreview(lineText string, startIndex, matchLength int) string {
	if startIndex < 0 {
		startIndex = 0
	}
	if startIndex > len(lineText) {
		startIndex = len(lineText)
	}

	previewStart := startIndex - 48
	if previewStart < 0 {
		previewStart = 0
	}

	previewEnd := startIndex + matchLength + 48
	if previewEnd > len(lineText) {
		previewEnd = len(lineText)
	}
	if previewEnd < previewStart {
		previewEnd = previewStart
	}

	return strings.TrimSpace(lineText[previewStart:previewEnd])
}

// --- SFTP scanning fallback --------------------------------------------------

// SearchByScanning mirrors searchInFilesByScanning in ssh-session.ts: a
// pure-SFTP recursive walk of rootPath, doing a literal (optionally
// case-insensitive) substring search line-by-line. It reuses this package's
// own ReadDir/ReadFile (already SFTP-only, no shell fallback, matching
// Phase 1's established precedent for this package - see fs.go). The
// original has no binary-file detection at all: it simply decodes every
// file as UTF-8 text via readFile and searches it, so this port does the
// same (Go's ReadFile similarly never errors on non-UTF-8 bytes, it just
// searches whatever string() produces).
func SearchByScanning(client FileSystem, input SearchInput) (SearchResult, error) {
	maxResults := input.MaxResults
	if maxResults <= 0 {
		maxResults = DefaultSearchResultLimit
	}

	re, err := compileLiteralQuery(input.Query, input.CaseSensitive)
	if err != nil {
		return SearchResult{}, err
	}

	var matches []SearchMatch
	truncated := false

	var visit func(remotePath string) error
	visit = func(remotePath string) error {
		if len(matches) >= maxResults {
			truncated = true
			return nil
		}

		info, statErr := client.Stat(remotePath)
		if statErr != nil {
			return statErr
		}

		if info.IsDir() {
			entries, readErr := ReadDir(client, remotePath)
			if readErr != nil {
				return readErr
			}
			for _, entry := range entries {
				if err := visit(entry.Path); err != nil {
					return err
				}
				if len(matches) >= maxResults {
					truncated = true
					return nil
				}
			}
			return nil
		}

		content, readErr := ReadFile(client, remotePath)
		if readErr != nil {
			return readErr
		}

		lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
		for lineIndex, lineText := range lines {
			for _, loc := range re.FindAllStringIndex(lineText, -1) {
				matchLength := loc[1] - loc[0]
				if matchLength < 1 {
					matchLength = 1
				}
				matches = append(matches, SearchMatch{
					Path:    remotePath,
					Line:    lineIndex + 1,
					Column:  loc[0] + 1,
					Preview: buildSearchPreview(lineText, loc[0], matchLength),
				})

				if len(matches) >= maxResults {
					truncated = true
					return nil
				}
			}
		}
		return nil
	}

	if err := visit(input.RootPath); err != nil {
		return SearchResult{}, err
	}

	return SearchResult{Query: input.Query, Matches: matches, Truncated: truncated}, nil
}

// compileLiteralQuery mirrors `new RegExp(escapeRegExp(query), caseSensitive
// ? 'g' : 'gi')`: a literal substring search (regex-escaped) with an
// optional case-insensitivity flag, expressed as a Go regexp so
// SearchByScanning can reuse FindAllStringIndex for non-overlapping matches.
func compileLiteralQuery(query string, caseSensitive bool) (*regexp.Regexp, error) {
	pattern := regexp.QuoteMeta(query)
	if !caseSensitive {
		pattern = "(?i)" + pattern
	}
	return regexp.Compile(pattern)
}
