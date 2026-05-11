/**
 * Error sanitization for MCP responses.
 *
 * MCP clients (and HTTP daemon callers) sit outside the trust boundary of
 * the workspace. Errors that bubble up from internal libraries often embed
 * absolute filesystem paths (`/Users/alice/repos/...`, `C:\Users\...`),
 * which leak the directory layout, the user's name, and sometimes the
 * customer / project name.
 *
 * `sanitizeForClient` strips absolute paths from a message before it
 * leaves the server. The full error (with paths) is logged to stderr so
 * the operator running the MCP daemon can still debug.
 *
 * This is defense-in-depth: every individual error-return site should also
 * prefer constructing messages from relative paths in the first place
 * (see indexer.resolveRef). The sanitizer catches the cases we missed.
 */

/**
 * Replace absolute filesystem paths in a message with `<path>`.
 *
 * Matches:
 *   - POSIX absolute paths starting with `/` at a word boundary
 *     (preceded by start-of-string, whitespace, or a quote/bracket).
 *     This avoids stripping the `/` inside relative refs like
 *     `doc/missing.md` while still catching `/Users/...` in any
 *     surrounding text.
 *   - Windows drive-letter paths like `C:\foo\bar` or `C:/foo/bar`
 *   - UNC paths like `\\server\share`
 *
 * Conservative: we err on the side of redacting rather than not.
 * Trailing punctuation (`.`, `,`, `:`, `;`, `)`, `]`, `'`, `"`) is
 * preserved outside the `<path>` token so messages remain readable.
 */
export function stripAbsolutePaths(message: string): string {
  return message
    .replace(/\\\\[^\s'"`)\]]+/g, "<path>") // UNC: \\server\share\...
    .replace(/[A-Za-z]:[\\/][^\s'"`)\]]+/g, "<path>") // Windows drive
    .replace(/(^|[\s'"`([])\/[^\s'"`)\]]+/g, "$1<path>"); // POSIX absolute
}

/**
 * Convert an unknown caught value to a safe message string for the client.
 *
 * - Logs the full original message to stderr (operator-visible).
 * - Returns the same message with absolute paths stripped.
 *
 * Use this at every place that surfaces a caught exception to an MCP
 * client / HTTP caller.
 */
export function sanitizeForClient(err: unknown, contextHint?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const prefix = contextHint ? `${contextHint}: ` : "";
  // Operator-visible full error.
  process.stderr.write(`mcp-doc-search error: ${prefix}${raw}\n`);
  return stripAbsolutePaths(raw);
}
