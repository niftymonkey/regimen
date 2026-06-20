/**
 * The newest Claude Code transcript path under a projects tree.
 *
 * assess reads the newest transcript as open (complete=false) and any older one
 * as complete, so it never force-closes a conversation it judged mid-flight.
 * Claude transcript files are named by session UUID, which does not sort into
 * chronological order, so newest is decided by file mtime (last activity), not
 * lexical comparison. Mirrors the Codex `newest-rollout.ts`, which can sort
 * lexically only because its file names embed an ISO8601 timestamp.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const TRANSCRIPT_FILE = /\.jsonl$/;

export function newestClaudeTranscript(projectsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  let newestMtime = -Infinity;
  let newestPath: string | null = null;
  for (const entry of entries) {
    if (!TRANSCRIPT_FILE.test(basename(entry))) continue;
    const path = join(projectsDir, entry);
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
