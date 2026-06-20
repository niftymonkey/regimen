/**
 * Locate the Claude Code transcript file for a given session id.
 *
 * Claude Code writes one transcript per session at
 * `<configHome>/projects/<cwd-slug>/<session-id>.jsonl`, named by the session
 * UUID (verified against the official Sessions docs). Unlike Codex, the session
 * id is not embedded in a longer file name: the file's base name IS the id plus
 * `.jsonl`. assess needs the reverse direction (session id to path), so a
 * recursive scan of the projects tree matches `<sessionId>.jsonl` and takes the
 * path without opening a file. A session id with no matching file returns null,
 * the fail-closed missing-transcript signal. This module is Claude-specific and
 * lives beside the Codex `locate-rollout.ts`.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The path of the transcript whose base name is `<sessionId>.jsonl`, or null
 * when none matches (or the projects tree cannot be read). No file is opened.
 */
export function locateClaudeTranscript(
  projectsDir: string,
  sessionId: string,
): string | null {
  const target = `${sessionId}.jsonl`;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (basename(entry) === target) return join(projectsDir, entry);
  }
  return null;
}
