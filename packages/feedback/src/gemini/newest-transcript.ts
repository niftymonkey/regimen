/**
 * The newest Gemini CLI transcript path under a sessions tree.
 *
 * assess reads the newest transcript as open (complete=false) and any older one
 * as complete, so it never force-closes a conversation it judged mid-flight.
 * Gemini keeps each session in `<sessionsDir>/<project-alias>/chats/session-*.jsonl`;
 * the filename embeds an ISO start time, but mtime is the safe key for last
 * activity, so newest is decided by file mtime. Mirrors the Codex/Claude/Copilot
 * newest-transcript modules.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const TRANSCRIPT_FILE = /^session-.*\.jsonl$/;

export function newestGeminiTranscript(sessionsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  let newestMtime = -Infinity;
  let newestPath: string | null = null;
  for (const entry of entries) {
    if (!TRANSCRIPT_FILE.test(basename(entry))) continue;
    const path = join(sessionsDir, entry);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      // The file was rotated or removed between the scan and the stat; skip it.
      continue;
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestPath = path;
    }
  }
  return newestPath;
}
