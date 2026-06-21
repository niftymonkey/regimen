/**
 * The Gemini adapters behind the harness ports: src/gemini is "the Gemini
 * implementation behind the ports", the sibling of src/codex, src/claude, and
 * src/copilot. `geminiReader` and `geminiResolver` wrap the pure Gemini
 * functions, they do not reimplement them, so the judge path depends on the port
 * interfaces while the Gemini behavior stays in its own modules.
 *
 * `geminiReader.read` IS the transcript reader `geminiRead`.
 * `geminiResolver.resolveCurrent` resolves the live session by filesystem (the
 * Codex pattern), since Gemini exposes no session id to the shell: it derives
 * the project alias from the cwd and reads the newest transcript's init-line id,
 * no stamp and no env var. `geminiResolver.locate` finds the transcript file for
 * a session id by reading each candidate's init line, and marks it open when it
 * is the newest (live) transcript by mtime, the rule that decides whether the
 * reader force-closes the conversation.
 */
import { geminiRead } from "../loader/rollout/gemini-reader.ts";
import type { SessionResolver, TranscriptReader } from "../harness/ports.ts";
import { locateGeminiTranscript } from "./locate-transcript.ts";
import { newestGeminiTranscript } from "./newest-transcript.ts";
import { resolveGeminiSession } from "./resolve-session.ts";

/** The Gemini transcript reader: `read` is the transcript reader `geminiRead`. */
export const geminiReader: TranscriptReader = {
  read: geminiRead,
};

/**
 * The Gemini session resolver. `resolveCurrent` resolves the live session by
 * filesystem (derive the project alias from the cwd, read the newest
 * transcript's init-line id); `locate` finds the transcript file for a session
 * id and marks it open when it is the newest (live) transcript.
 */
export const geminiResolver: SessionResolver = {
  resolveCurrent(ctx) {
    return resolveGeminiSession(ctx);
  },
  locate(args) {
    const path = locateGeminiTranscript(args.sessionsDir, args.sessionId);
    if (path === null) return null;
    const open = newestGeminiTranscript(args.sessionsDir) === path;
    return { path, open };
  },
};
