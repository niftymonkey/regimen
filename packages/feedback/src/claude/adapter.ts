/**
 * The Claude adapters behind the harness ports: src/claude is "the Claude
 * implementation behind the ports", the sibling of src/codex. `claudeReader`
 * and `claudeResolver` wrap the pure Claude functions, they do not reimplement
 * them, so the judge path depends on the port interfaces while the Claude
 * behavior stays in its own modules.
 *
 * `claudeReader.read` IS the transcript reader `claudeRead`.
 * `claudeResolver.resolveCurrent` reads the session id Claude Code exposes to
 * the shell (`CLAUDE_CODE_SESSION_ID`), no stamp and no scan, since Claude (
 * unlike Codex) hands the agent its own session id; `claudeResolver.locate`
 * wraps `locateClaudeTranscript` and computes openness with the newest-by-mtime
 * rule (Claude transcript names are UUIDs and do not sort chronologically).
 */
import { claudeRead } from "../loader/rollout/claude-reader.ts";
import type { SessionResolver, TranscriptReader } from "../harness/ports.ts";
import { locateClaudeTranscript } from "./locate-transcript.ts";
import { newestClaudeTranscript } from "./newest-transcript.ts";
import { resolveClaudeSession } from "./resolve-session.ts";

/** The Claude transcript reader: `read` is the transcript reader `claudeRead`. */
export const claudeReader: TranscriptReader = {
  read: claudeRead,
};

/**
 * The Claude session resolver. `resolveCurrent` reads the session id Claude
 * exposes to the agent's shell; `locate` finds the transcript file for a session
 * id and marks it open when it is the newest (live) transcript, the rule that
 * decides whether the reader force-closes the conversation.
 */
export const claudeResolver: SessionResolver = {
  resolveCurrent() {
    return resolveClaudeSession(process.env);
  },
  locate(args) {
    const path = locateClaudeTranscript(args.sessionsDir, args.sessionId);
    if (path === null) return null;
    const open = newestClaudeTranscript(args.sessionsDir) === path;
    return { path, open };
  },
};
