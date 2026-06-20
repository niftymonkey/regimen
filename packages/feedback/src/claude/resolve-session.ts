/**
 * Resolve the session id of the Claude Code conversation live in the agent's
 * shell.
 *
 * Unlike Codex, Claude Code exposes its session id to the agent's shell via the
 * `CLAUDE_CODE_SESSION_ID` environment variable (set in hook and Bash tool
 * subprocesses, verified against the official env-vars docs). So resolution is
 * a direct env read: no per-cwd stamp, no newest-by-mtime scan. The id is read
 * straight from the environment, and absent or empty it returns null, the
 * fail-closed "no current session" signal. This module is Claude-specific; the
 * generic evidence read side stays harness-agnostic.
 */

/** The environment variable Claude Code sets to the current session id. */
export const CLAUDE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

export function resolveClaudeSession(
  env: Partial<NodeJS.ProcessEnv>,
): string | null {
  const value = env[CLAUDE_SESSION_ID_ENV];
  return typeof value === "string" && value.length > 0 ? value : null;
}
