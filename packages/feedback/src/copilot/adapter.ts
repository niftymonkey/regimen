/**
 * The Copilot adapters behind the harness ports: src/copilot is "the Copilot
 * implementation behind the ports", the sibling of src/codex and src/claude.
 * `copilotReader` and `copilotResolver` wrap the pure Copilot functions, they
 * do not reimplement them, so the judge path depends on the port interfaces
 * while the Copilot behavior stays in its own modules.
 *
 * `copilotReader.read` IS the transcript reader `copilotRead`.
 * `copilotResolver.resolveCurrent` reads the session id Copilot CLI exposes to
 * the shell (`COPILOT_AGENT_SESSION_ID`), no stamp and no scan, since Copilot (
 * like Claude, unlike Codex) hands the agent its own session id;
 * `copilotResolver.locate` joins the deterministic per-session path and computes
 * openness with the newest-by-mtime rule (Copilot session ids are UUIDs and do
 * not sort chronologically).
 */
import { copilotRead } from "../loader/rollout/copilot-reader.ts";
import type { SessionResolver, TranscriptReader } from "../harness/ports.ts";
import { locateCopilotTranscript } from "./locate-transcript.ts";
import { newestCopilotTranscript } from "./newest-transcript.ts";
import { resolveCopilotSession } from "./resolve-session.ts";

/** The Copilot transcript reader: `read` is the transcript reader `copilotRead`. */
export const copilotReader: TranscriptReader = {
  read: copilotRead,
};

/**
 * The Copilot session resolver. `resolveCurrent` reads the session id Copilot
 * exposes to the agent's shell; `locate` finds the transcript file for a session
 * id and marks it open when it is the newest (live) transcript, the rule that
 * decides whether the reader force-closes the conversation.
 */
export const copilotResolver: SessionResolver = {
  resolveCurrent() {
    return resolveCopilotSession(process.env);
  },
  locate(args) {
    const path = locateCopilotTranscript(args.sessionsDir, args.sessionId);
    if (path === null) return null;
    const open = newestCopilotTranscript(args.sessionsDir) === path;
    return { path, open };
  },
};
