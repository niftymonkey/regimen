/**
 * Resolve the session id of the Gemini CLI conversation live in a given working
 * directory, so the in-session evidence skill can read its own signals.
 *
 * Gemini exposes no session-id environment variable to the agent's shell (unlike
 * Claude's `CLAUDE_CODE_SESSION_ID` or Copilot's `COPILOT_AGENT_SESSION_ID`), so
 * resolution is filesystem-based, the Codex pattern. Gemini stores a session's
 * transcript under a project-alias derived from the workspace directory:
 * `<harnessHome>/tmp/<alias>/chats/session-*.jsonl`, where `<alias>` is the
 * basename of the cwd. The resolver scans that alias's `chats` directory for the
 * newest `session-*.jsonl` by mtime (last activity) and reads its line-0 init
 * record's full `sessionId`. No stamp file is written or read: Gemini needs none.
 * Absent any transcript it returns null, the fail-closed "no current session"
 * signal.
 *
 * This module is Gemini-specific; the generic evidence read side and the
 * `EvidenceDigest` contract stay harness-agnostic.
 */
import { basename, join } from "node:path";
import { readTranscriptSessionId } from "./locate-transcript.ts";
import { newestGeminiTranscript } from "./newest-transcript.ts";

export function resolveGeminiSession(ctx: {
  dataDir: string;
  harnessHome: string;
  cwd: string;
}): string | null {
  const alias = basename(ctx.cwd);
  const chatsDir = join(ctx.harnessHome, "tmp", alias, "chats");
  const newest = newestGeminiTranscript(chatsDir);
  if (newest === null) return null;
  return readTranscriptSessionId(newest);
}
