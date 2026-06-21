/**
 * Locate the Gemini CLI transcript file for a given session id.
 *
 * Gemini exposes no session id to the shell, so resolution is by filesystem.
 * One transcript per session lives at
 * `<sessionsDir>/<project-alias>/chats/session-<ISO>-<hex8>.jsonl`, where the
 * filename's `<hex8>` is only the first 8 chars of the full session id. The
 * robust key is the full id, which is stamped on each file's line-0 init record
 * (`sessionId`), so the locator recursively scans for `session-*.jsonl` files
 * and matches by reading each candidate's init line. A session id with no
 * matching file returns null, the fail-closed missing-transcript signal. This
 * module is Gemini-specific and lives beside the Codex `locate-rollout.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const TRANSCRIPT_FILE = /^session-.*\.jsonl$/;

/** The full session id stamped on a transcript file's line-0 init record. */
export function readTranscriptSessionId(path: string): string | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const firstLine = content.split("\n", 1)[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed === "object" && parsed !== null) {
      const id = (parsed as Record<string, unknown>).sessionId;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The path of the `session-*.jsonl` under `sessionsDir` whose line-0 init record
 * carries `sessionId`, or null when none matches (or the tree cannot be read).
 */
export function locateGeminiTranscript(
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
    if (!TRANSCRIPT_FILE.test(basename(entry))) continue;
    const path = join(sessionsDir, entry);
    if (readTranscriptSessionId(path) === sessionId) return path;
  }
  return null;
}
