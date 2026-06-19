/**
 * The newest Codex rollout file name under a sessions tree (S3).
 *
 * The `rollout-<ISO8601>-<uuid>.jsonl` name sorts lexically into chronological
 * order, so the lexically-greatest base name is the newest (live) rollout, the
 * same rule the tailer uses to decide which conversation is open. assess reads
 * the newest rollout as open (complete=false) and any older one as complete, so
 * it never force-closes a conversation it judged mid-flight. The comparison is
 * the byte-wise `>` operator, not localeCompare, because locale collation can
 * reorder ISO8601 timestamps; lexical comparison is correct and locale-independent.
 */
import { readdirSync } from "node:fs";
import { basename } from "node:path";

const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;

/**
 * The base name of the newest rollout under `sessionsDir`, or null when the
 * tree has no rollout files or cannot be read.
 */
export function newestRolloutName(sessionsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  let newest: string | null = null;
  for (const entry of entries) {
    const name = basename(entry);
    if (!ROLLOUT_FILE.test(name)) continue;
    if (newest === null || name > newest) newest = name;
  }
  return newest;
}
