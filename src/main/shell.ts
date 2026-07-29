/**
 * Single-quoting helper for remote shell commands. Shared by every module that
 * builds a command string so no caller has to reinvent the escaping rules.
 */
export function quoteForShell(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid shell path');
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
