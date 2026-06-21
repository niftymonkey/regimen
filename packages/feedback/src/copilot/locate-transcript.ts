/**
 * Locate the GitHub Copilot CLI transcript file for a given session id.
 *
 * Copilot CLI writes one transcript per session at
 * `<configHome>/session-state/<session-id>/events.jsonl`. Unlike Claude (whose
 * transcript lives under a cwd-slug directory that must be scanned for) and
 * Codex (whose file name embeds a timestamp), Copilot's path is fully
 * deterministic from the session id, so the locator joins the path and checks
 * that the file exists. A session id with no file returns null, the fail-closed
 * missing-transcript signal. This module is Copilot-specific and lives beside
 * the Claude `locate-transcript.ts`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The path `<sessionsDir>/<sessionId>/events.jsonl` when it exists, else null
 * (the missing-transcript signal). No file is opened.
 */
export function locateCopilotTranscript(
  sessionsDir: string,
  sessionId: string,
): string | null {
  const path = join(sessionsDir, sessionId, "events.jsonl");
  return existsSync(path) ? path : null;
}
