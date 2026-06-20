/**
 * Locate the Codex rollout transcript file for a given session id (S3).
 *
 * The session resolver goes file name to id, and the tailer reads every file;
 * nothing maps a session id back to its rollout path. assess needs that reverse
 * direction. The Codex rollout file name embeds the session id as its trailing
 * UUID (rollout-<ISO8601>-<uuid>.jsonl), so a recursive scan of the sessions
 * tree matches the UUID and takes the path without opening a file. A session id
 * with no matching file returns null, the fail-closed missing-transcript signal.
 * This module is Codex-specific and lives beside resolve-session.ts.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const ROLLOUT_FILE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * The path of the rollout file whose trailing UUID is `sessionId`, or null when
 * none matches (or the sessions tree cannot be read). No file is opened: the id
 * is read from the file name, like resolve-session.ts.
 */
export function locateRolloutFile(
  sessionsDir: string,
  sessionId: string,
): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  for (const entry of entries) {
    const match = ROLLOUT_FILE.exec(basename(entry));
    if (match !== null && match[1] === sessionId) {
      return join(sessionsDir, entry);
    }
  }
  return null;
}
