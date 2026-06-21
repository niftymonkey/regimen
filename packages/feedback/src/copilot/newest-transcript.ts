/**
 * The newest GitHub Copilot CLI transcript path under a session-state tree.
 *
 * assess reads the newest transcript as open (complete=false) and any older one
 * as complete, so it never force-closes a conversation it judged mid-flight.
 * Copilot keeps each session in its own directory `<sessionsDir>/<id>/`, with
 * the conversation in `events.jsonl`; the session id (a UUID) does not sort
 * chronologically, so newest is decided by file mtime (last activity). Mirrors
 * the Claude `newest-transcript.ts`.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TRANSCRIPT_FILE = "events.jsonl";

export function newestCopilotTranscript(sessionsDir: string): string | null {
  let sessionIds: string[];
  try {
    sessionIds = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  let newestMtime = -Infinity;
  let newestPath: string | null = null;
  for (const sessionId of sessionIds) {
    const path = join(sessionsDir, sessionId, TRANSCRIPT_FILE);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // No events.jsonl in this session directory (or it was removed between
      // the scan and the stat); skip it.
      continue;
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestPath = path;
    }
  }
  return newestPath;
}
