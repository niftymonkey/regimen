/**
 * Resolve the session id of the GitHub Copilot CLI conversation live in the
 * agent's shell.
 *
 * Like Claude Code, Copilot CLI exposes its session id to the agent's shell via
 * an environment variable (`COPILOT_AGENT_SESSION_ID`), so resolution is a
 * direct env read: no per-cwd stamp, no newest-by-mtime scan. The id is read
 * straight from the environment, and absent or empty it returns null, the
 * fail-closed "no current session" signal. This module is Copilot-specific; the
 * generic evidence read side stays harness-agnostic.
 */

/** The environment variable Copilot CLI sets to the current session id. */
export const COPILOT_SESSION_ID_ENV = "COPILOT_AGENT_SESSION_ID";

export function resolveCopilotSession(
  env: Partial<NodeJS.ProcessEnv>,
): string | null {
  const value = env[COPILOT_SESSION_ID_ENV];
  return typeof value === "string" && value.length > 0 ? value : null;
}
