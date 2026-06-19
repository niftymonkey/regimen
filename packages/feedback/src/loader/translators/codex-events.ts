/**
 * The Codex v1 event vocabulary, shared by both Codex producers.
 *
 * Two paths turn a Codex conversation into v1 events: the hook translator
 * (`codex.ts`, real-time, from hook payloads) and the rollout reader
 * (`../rollout/codex-reader.ts`, the fallback and judge-time source, from
 * the rollout transcript). They read different inputs but must emit the
 * identical event vocabulary, or the store and the signal projections would
 * treat the two capture paths inconsistently. These builders are that single
 * source of truth: the event_type, span phase, span name, harness stamp, and
 * trace-id derivation live here once, so the two producers cannot drift.
 */
import {
  traceIdFor,
  type RegimenEvent,
  type SpanPhase,
} from "../../../hooks/event-log.ts";
import { normalizeCodexEndReason } from "./end-reason.ts";

/** The session-scoped fields every Codex v1 event carries. */
export interface CodexEventBase {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly model?: string;
  /** The working directory the session ran in, when the source reports one. */
  readonly cwd?: string;
}

/** Tool span identity, shared by tool.pre and tool.post. */
export interface CodexToolSpan {
  readonly toolName: string;
  readonly toolCallId: string;
  /** Set only when the tool reported a file it mutated (drives file churn). */
  readonly filePath?: string;
  /** Set only for a web_search tool span: the query the agent searched. */
  readonly query?: string;
  /** Set only for a skill invocation: the slug of the skill the agent ran. */
  readonly skillName?: string;
}

function codexEvent(
  base: CodexEventBase,
  eventType: string,
  spanPhase: SpanPhase,
  spanName: string,
  attributes: Record<string, string>,
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: base.timestamp,
    session_id: base.sessionId,
    harness: "codex",
    ...(base.model !== undefined ? { model: base.model } : {}),
    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
    event_type: eventType,
    trace_id: traceIdFor(base.sessionId),
    span_phase: spanPhase,
    span_name: spanName,
    attributes,
  };
}

export function codexSessionStart(base: CodexEventBase): RegimenEvent {
  return codexEvent(base, "session.start", "start", "session", {});
}

export function codexSessionEnd(base: CodexEventBase): RegimenEvent {
  return codexEvent(base, "session.end", "end", "session", {
    end_reason_normalized: normalizeCodexEndReason(undefined),
  });
}

/**
 * The per-session sequence attribute, set only on the rollout path. Two
 * conversation turns can share a millisecond timestamp (verified in the
 * transcripts), so without a per-session ordinal their structural events hash
 * identically and `INSERT OR IGNORE` drops the second, breaking the anchor the
 * content projection resolves against. The rollout reader passes the line
 * order; the hook translator omits it (the hook path emits one event per
 * captured moment, so it has no within-transcript collision to break).
 */
function seqAttribute(seq: number | undefined): Record<string, string> {
  return seq !== undefined ? { seq: String(seq) } : {};
}

export function codexUserPrompt(
  base: CodexEventBase,
  seq?: number,
): RegimenEvent {
  return codexEvent(
    base,
    "user_prompt",
    "point",
    "user_prompt",
    seqAttribute(seq),
  );
}

export function codexAgentMessage(
  base: CodexEventBase,
  seq?: number,
): RegimenEvent {
  return codexEvent(
    base,
    "agent.message",
    "point",
    "agent_message",
    seqAttribute(seq),
  );
}

export function codexCompaction(
  base: CodexEventBase,
  trigger?: string,
): RegimenEvent {
  return codexEvent(
    base,
    "compaction",
    "point",
    "compaction",
    trigger !== undefined ? { trigger } : {},
  );
}

function toolAttributes(span: CodexToolSpan): Record<string, string> {
  const attributes: Record<string, string> = {
    tool_name: span.toolName,
    tool_call_id: span.toolCallId,
  };
  if (span.filePath !== undefined) attributes.file_path = span.filePath;
  if (span.query !== undefined) attributes.query = span.query;
  if (span.skillName !== undefined) attributes.skill_name = span.skillName;
  return attributes;
}

export function codexToolPre(
  base: CodexEventBase,
  span: CodexToolSpan,
): RegimenEvent {
  return codexEvent(
    base,
    "tool.pre",
    "start",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}

export function codexToolPost(
  base: CodexEventBase,
  span: CodexToolSpan,
): RegimenEvent {
  return codexEvent(
    base,
    "tool.post",
    "end",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}
