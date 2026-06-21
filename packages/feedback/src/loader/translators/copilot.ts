/**
 * The GitHub Copilot CLI translator: one envelope to one canonical v1 event.
 *
 * Pure function from an envelope produced by the Copilot capture hook to a v1
 * event the loader writes to the events table, the Copilot counterpart of the
 * Claude, Codex, and Gemini translators. Per ADR-0006 the translator registry
 * is the only harness-specific seam in the loader, so adding Copilot's live
 * path is this one file plus one map entry. The v1 events are built with the
 * shared Copilot vocabulary in `copilot-events.ts`, the single source of truth
 * this translator and the Copilot transcript reader both emit through, so the
 * real-time hook path and the judge-time reader cannot drift on event_type,
 * span phase, span name, harness stamp, or trace-id derivation.
 *
 * The honest divergence from the other three translators is event-type
 * inference. Claude, Codex, and Gemini stamp the firing hook's name onto the
 * payload (`hook_event_name`) and their translators dispatch on it. The GitHub
 * Copilot CLI hook stdin payload carries no event-name field at all; the
 * official GitHub docs state scripts must be dedicated to specific hooks
 * precisely because the input does not identify which hook fired. So this
 * translator infers the event type from the payload's field shape, against the
 * five shapes a real headless Copilot run produces (each also carrying a
 * `sessionId`, `cwd`, and an epoch-millisecond `timestamp`):
 *   - `toolName` present -> a tool event; `toolResult` present discriminates
 *     `tool.post` from `tool.pre`.
 *   - `initialPrompt` or `source` present -> `session.start`.
 *   - `prompt` present -> `user_prompt`.
 *   - `reason` present -> `session.end`.
 * The order matters: the tool check runs first because a tool payload also
 * carries other fields, and the more specific tool shape must win.
 *
 * Two further honest divergences, both rooted in Copilot's hook surface:
 *   - The Copilot hook payload carries no model field, so `model` is always
 *     undefined here (correctly: the source reports none).
 *   - It carries no tool-call id, so the tool span pairs by falling back to the
 *     envelope timestamp, the same fallback the Claude, Codex, and Gemini
 *     translators use when an id is absent.
 *
 * The translator returns:
 *   - `{ kind: "event" }` for a payload whose shape maps to a v1 event.
 *   - `{ kind: "skip" }` for a recognized-as-Copilot but unmapped shape; adding
 *     a mapping later is purely additive.
 *   - `{ kind: "quarantine" }` when the payload is not an object, so no
 *     trustworthy event can be derived.
 */
import {
  readString,
  type Envelope,
  type TranslateResult,
} from "../../envelope.ts";
import {
  copilotSessionEnd,
  copilotSessionStart,
  copilotToolPost,
  copilotToolPre,
  copilotUserPrompt,
  type CopilotEventBase,
  type CopilotToolSpan,
} from "./copilot-events.ts";

/**
 * The Copilot hook payload carries no tool-call id, so the span pairs by
 * falling back to the envelope timestamp, the same fallback the Claude, Codex,
 * and Gemini translators use when an id is absent.
 */
function toolSpan(
  payload: Record<string, unknown>,
  fallbackCallId: string,
): CopilotToolSpan {
  return {
    toolName: readString(payload, "toolName") ?? "unknown",
    toolCallId: fallbackCallId,
  };
}

export function translateCopilot(envelope: Envelope): TranslateResult {
  if (typeof envelope.payload !== "object" || envelope.payload === null) {
    return { kind: "quarantine", reason: "copilot payload is not an object" };
  }
  const payload = envelope.payload as Record<string, unknown>;
  const base: CopilotEventBase = {
    sessionId: readString(payload, "sessionId") ?? "unknown",
    timestamp: envelope.captured_at,
    model: readString(payload, "model"),
    cwd: readString(payload, "cwd"),
  };

  if ("toolName" in payload) {
    const span = toolSpan(payload, base.timestamp);
    const event =
      "toolResult" in payload
        ? copilotToolPost(base, span)
        : copilotToolPre(base, span);
    return { kind: "event", event };
  }
  if ("initialPrompt" in payload || "source" in payload) {
    return { kind: "event", event: copilotSessionStart(base) };
  }
  if ("prompt" in payload) {
    return { kind: "event", event: copilotUserPrompt(base) };
  }
  if ("reason" in payload) {
    return {
      kind: "event",
      event: copilotSessionEnd(base, readString(payload, "reason")),
    };
  }
  return { kind: "skip" };
}
