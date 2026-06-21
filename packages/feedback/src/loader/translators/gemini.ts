/**
 * The Gemini CLI translator: one envelope to one canonical v1 event.
 *
 * Pure function from an envelope produced by the Gemini capture hook to a v1
 * event the loader writes to the events table, the Gemini counterpart of the
 * Claude and Codex translators. Per ADR-0006 the translator registry is the
 * only harness-specific seam in the loader, so adding Gemini is this one file
 * plus one map entry.
 *
 * It maps the five Gemini hook events the capture hook wires (SessionStart,
 * BeforeAgent, BeforeTool, AfterTool, SessionEnd). The v1 events are built with
 * the shared Gemini vocabulary in `gemini-events.ts`, the single source of
 * truth this translator and the Gemini transcript reader both emit through, so
 * the real-time hook path and the judge-time reader cannot drift on event_type,
 * span phase, span name, harness stamp, or trace-id derivation.
 *
 * Two honest divergences from Claude, both rooted in Gemini's hook surface:
 *   - Gemini's user-prompt-submitted signal is `BeforeAgent` (its payload
 *     carries the `prompt`), not Claude's `UserPromptSubmit`.
 *   - The Gemini hook payload carries no model field and no tool-call id, so the
 *     tool span pairs by falling back to the envelope timestamp, the same
 *     fallback the Claude and Codex translators use when an id is absent.
 *
 * The translator returns:
 *   - `{ kind: "event" }` for a mapped hook event.
 *   - `{ kind: "skip" }` for a valid Gemini hook event with no v1 mapping (for
 *     example `PreCompress`, `BeforeModel`, or `Notification` today). Adding a
 *     mapping later is purely additive.
 *   - `{ kind: "quarantine" }` when the payload is malformed enough that no
 *     trustworthy event can be derived (not an object, or no `hook_event_name`).
 */
import {
  readString,
  type Envelope,
  type TranslateResult,
} from "../../envelope.ts";
import { type RegimenEvent } from "../../../hooks/event-log.ts";
import {
  geminiSessionEnd,
  geminiSessionStart,
  geminiToolPost,
  geminiToolPre,
  geminiUserPrompt,
  type GeminiEventBase,
  type GeminiToolSpan,
} from "./gemini-events.ts";

/** Gemini hook event name -> the v1 `event_type` it maps to. */
const EVENT_TYPE: Readonly<Record<string, string>> = {
  SessionStart: "session.start",
  BeforeAgent: "user_prompt",
  BeforeTool: "tool.pre",
  AfterTool: "tool.post",
  SessionEnd: "session.end",
};

/**
 * The Gemini hook payload carries no tool-call id, so the span pairs by
 * falling back to the envelope timestamp, the same fallback the Claude and
 * Codex translators use when an id is absent.
 */
function toolSpan(
  payload: Record<string, unknown>,
  fallbackCallId: string,
): GeminiToolSpan {
  return {
    toolName: readString(payload, "tool_name") ?? "unknown",
    toolCallId: fallbackCallId,
  };
}

export function translateGemini(envelope: Envelope): TranslateResult {
  if (typeof envelope.payload !== "object" || envelope.payload === null) {
    return { kind: "quarantine", reason: "gemini payload is not an object" };
  }
  const payload = envelope.payload as Record<string, unknown>;
  const hookEventName = readString(payload, "hook_event_name");
  if (hookEventName === undefined) {
    return {
      kind: "quarantine",
      reason: "gemini payload missing hook_event_name",
    };
  }
  const eventType = EVENT_TYPE[hookEventName];
  if (eventType === undefined) return { kind: "skip" };

  const base: GeminiEventBase = {
    sessionId: readString(payload, "session_id") ?? "unknown",
    timestamp: envelope.captured_at,
    model: readString(payload, "model"),
    cwd: readString(payload, "cwd"),
  };

  let event: RegimenEvent;
  switch (eventType) {
    case "session.start":
      event = geminiSessionStart(base);
      break;
    case "session.end":
      event = geminiSessionEnd(base, readString(payload, "reason"));
      break;
    case "tool.pre":
      event = geminiToolPre(base, toolSpan(payload, base.timestamp));
      break;
    case "tool.post":
      event = geminiToolPost(base, toolSpan(payload, base.timestamp));
      break;
    default:
      event = geminiUserPrompt(base);
      break;
  }
  return { kind: "event", event };
}
