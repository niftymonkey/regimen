/**
 * The Gemini CLI v1 event vocabulary, used by the Gemini transcript reader.
 *
 * Gemini turns an on-disk conversation into v1 events through one path today:
 * the transcript reader (`../rollout/gemini-reader.ts`, the judge-time source,
 * from the per-session `chats/session-*.jsonl` log). A live-capture hook
 * translator is deferred until the full Gemini hook-event payload taxonomy is
 * producer-confirmed, so these builders are consumed by the reader alone for
 * now. They are still the single source of truth for the event_type, span
 * phase, span name, harness stamp, and trace-id derivation, so a future hook
 * path can emit through them without drifting from the reader. Mirrors
 * claude-events.ts / copilot-events.ts.
 */
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent, type SpanPhase } from "../../../hooks/event-log.ts";
import { normalizeGeminiEndReason } from "./end-reason.ts";

/** The session-scoped fields every Gemini v1 event carries. */
export interface GeminiEventBase {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly model?: string;
  /** The working directory the session ran in, when the source reports one. */
  readonly cwd?: string;
}

/** Tool span identity, shared by tool.pre and tool.post. */
export interface GeminiToolSpan {
  readonly toolName: string;
  readonly toolCallId: string;
}

function geminiEvent(
  base: GeminiEventBase,
  eventType: string,
  spanPhase: SpanPhase,
  spanName: string,
  attributes: Record<string, string>,
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: base.timestamp,
    session_id: base.sessionId,
    harness: "gemini",
    ...(base.model !== undefined ? { model: base.model } : {}),
    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
    event_type: eventType,
    trace_id: traceIdFor(base.sessionId),
    span_phase: spanPhase,
    span_name: spanName,
    attributes,
  };
}

export function geminiSessionStart(base: GeminiEventBase): RegimenEvent {
  return geminiEvent(base, "session.start", "start", "session", {});
}

export function geminiSessionEnd(
  base: GeminiEventBase,
  nativeReason?: string,
): RegimenEvent {
  const attributes: Record<string, string> = {
    end_reason_normalized: normalizeGeminiEndReason(nativeReason),
  };
  if (nativeReason !== undefined) attributes.end_reason_native = nativeReason;
  return geminiEvent(base, "session.end", "end", "session", attributes);
}

/**
 * The per-session sequence attribute, set on the rollout path. Two consecutive
 * `gemini` messages can share an ISO timestamp (Gemini writes a thinking-only
 * turn and its answer turn at the same captured second), so without a
 * per-session ordinal their structural events hash identically and
 * `INSERT OR IGNORE` drops the second, breaking the anchor the content
 * projection resolves against. The reader passes the projection order.
 */
function seqAttribute(seq: number | undefined): Record<string, string> {
  return seq !== undefined ? { seq: String(seq) } : {};
}

export function geminiUserPrompt(
  base: GeminiEventBase,
  seq?: number,
): RegimenEvent {
  return geminiEvent(
    base,
    "user_prompt",
    "point",
    "user_prompt",
    seqAttribute(seq),
  );
}

export function geminiAgentMessage(
  base: GeminiEventBase,
  seq?: number,
): RegimenEvent {
  return geminiEvent(
    base,
    "agent.message",
    "point",
    "agent_message",
    seqAttribute(seq),
  );
}

function toolAttributes(span: GeminiToolSpan): Record<string, string> {
  return {
    tool_name: span.toolName,
    tool_call_id: span.toolCallId,
  };
}

export function geminiToolPre(
  base: GeminiEventBase,
  span: GeminiToolSpan,
): RegimenEvent {
  return geminiEvent(
    base,
    "tool.pre",
    "start",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}

export function geminiToolPost(
  base: GeminiEventBase,
  span: GeminiToolSpan,
): RegimenEvent {
  return geminiEvent(
    base,
    "tool.post",
    "end",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}
