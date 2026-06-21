/**
 * The Copilot v1 event vocabulary, used by the Copilot transcript reader.
 *
 * Copilot turns an on-disk conversation into v1 events through one path today:
 * the transcript reader (`../rollout/copilot-reader.ts`, the judge-time source,
 * from the `events.jsonl` session log). A live-capture hook translator is
 * deferred until the full Copilot hook-event taxonomy is producer-confirmed, so
 * these builders are consumed by the reader alone for now. They are still the
 * single source of truth for the event_type, span phase, span name, harness
 * stamp, and trace-id derivation, so a future hook path can emit through them
 * without drifting from the reader. Mirrors claude-events.ts.
 */
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent, type SpanPhase } from "../../../hooks/event-log.ts";
import { normalizeCopilotEndReason } from "./end-reason.ts";

/** The session-scoped fields every Copilot v1 event carries. */
export interface CopilotEventBase {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly model?: string;
  /** The working directory the session ran in, when the source reports one. */
  readonly cwd?: string;
}

/** Tool span identity, shared by tool.pre and tool.post. */
export interface CopilotToolSpan {
  readonly toolName: string;
  readonly toolCallId: string;
}

function copilotEvent(
  base: CopilotEventBase,
  eventType: string,
  spanPhase: SpanPhase,
  spanName: string,
  attributes: Record<string, string>,
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: base.timestamp,
    session_id: base.sessionId,
    harness: "copilot",
    ...(base.model !== undefined ? { model: base.model } : {}),
    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
    event_type: eventType,
    trace_id: traceIdFor(base.sessionId),
    span_phase: spanPhase,
    span_name: spanName,
    attributes,
  };
}

export function copilotSessionStart(base: CopilotEventBase): RegimenEvent {
  return copilotEvent(base, "session.start", "start", "session", {});
}

export function copilotSessionEnd(
  base: CopilotEventBase,
  nativeReason?: string,
): RegimenEvent {
  const attributes: Record<string, string> = {
    end_reason_normalized: normalizeCopilotEndReason(nativeReason),
  };
  if (nativeReason !== undefined) attributes.end_reason_native = nativeReason;
  return copilotEvent(base, "session.end", "end", "session", attributes);
}

/**
 * The per-session sequence attribute, set on the rollout path. Two conversation
 * turns can share a millisecond timestamp (Copilot writes a tool.execution_start
 * at the same captured millisecond as its assistant.message), so without a
 * per-session ordinal their structural events hash identically and
 * `INSERT OR IGNORE` drops the second, breaking the anchor the content
 * projection resolves against. The reader passes the projection order.
 */
function seqAttribute(seq: number | undefined): Record<string, string> {
  return seq !== undefined ? { seq: String(seq) } : {};
}

export function copilotUserPrompt(
  base: CopilotEventBase,
  seq?: number,
): RegimenEvent {
  return copilotEvent(
    base,
    "user_prompt",
    "point",
    "user_prompt",
    seqAttribute(seq),
  );
}

export function copilotAgentMessage(
  base: CopilotEventBase,
  seq?: number,
): RegimenEvent {
  return copilotEvent(
    base,
    "agent.message",
    "point",
    "agent_message",
    seqAttribute(seq),
  );
}

function toolAttributes(span: CopilotToolSpan): Record<string, string> {
  return {
    tool_name: span.toolName,
    tool_call_id: span.toolCallId,
  };
}

export function copilotToolPre(
  base: CopilotEventBase,
  span: CopilotToolSpan,
): RegimenEvent {
  return copilotEvent(
    base,
    "tool.pre",
    "start",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}

export function copilotToolPost(
  base: CopilotEventBase,
  span: CopilotToolSpan,
): RegimenEvent {
  return copilotEvent(
    base,
    "tool.post",
    "end",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}
