package ssh

import "strings"

// QuoteForShell is a single-quoting helper for remote shell commands. Ported
// from src/main/shell.ts's quoteForShell.
func QuoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}
