/**
 * The clone-path safety check, shared by both instruments' install layers. It
 * depends on nothing else, so any builder or planner that interpolates a clone
 * path into a double-quoted POSIX-shell command can import it without a circular
 * import.
 */

/**
 * Reject a clonePath that would break out of, or inject into, the double-quoted
 * POSIX-shell context the path is interpolated into (`bun "<path>/..."`,
 * `bash "<path>/..."`). Only the characters special INSIDE double quotes are
 * rejected: the double quote `"` (closes the quote), the dollar `$` (parameter
 * and command substitution), the backtick `` ` `` (command substitution), the
 * backslash `\` (escape), and any control character including newline and
 * carriage return. Everything else, including `;` `|` `&` `(` `)` `'` `{` `}`
 * `[` `]` `*` `?` and space, is a literal inside double quotes and stays allowed
 * because it appears in real directory names. Fails loud so the planner never
 * emits a command that could be hijacked by a crafted clone path.
 */
export function assertSafeClonePath(clonePath: string): void {
  if (/["$`\\]/.test(clonePath)) {
    throw new Error(
      `clonePath contains a shell-unsafe character (one of " $ \` \\), which is special inside double quotes: ${JSON.stringify(clonePath)}`,
    );
  }
  for (let i = 0; i < clonePath.length; i++) {
    if (clonePath.charCodeAt(i) <= 0x1f) {
      throw new Error(
        `clonePath contains a control character (e.g. newline or carriage return), which is unsafe in a shell command: ${JSON.stringify(clonePath)}`,
      );
    }
  }
}
