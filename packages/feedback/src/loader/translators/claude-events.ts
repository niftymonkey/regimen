/**
 * The Claude v1 event vocabulary, shared by both Claude producers.
 *
 * Two paths turn a Claude conversation into v1 events: the hook translator
 * (`claude.ts`, real-time, from hook payloads) and the transcript reader
 * (`../rollout/claude-reader.ts`, the judge-time source, from the on-disk
 * transcript). They read different inputs but must emit the identical event
 * vocabulary, or the store and the signal projections would treat the two
 * capture paths inconsistently. These builders are that single source of truth:
 * the event_type, span phase, span name, harness stamp, and trace-id derivation
 * live here once, so the two producers cannot drift. Mirrors codex-events.ts.
 */
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent, type SpanPhase } from "../../../hooks/event-log.ts";
import { normalizeClaudeEndReason } from "./end-reason.ts";

/** The session-scoped fields every Claude v1 event carries. */
export interface ClaudeEventBase {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly model?: string;
  /** The working directory the session ran in, when the source reports one. */
  readonly cwd?: string;
}

/** Tool span identity, shared by tool.pre and tool.post. */
export interface ClaudeToolSpan {
  readonly toolName: string;
  readonly toolCallId: string;
  /** Set only when the tool reported a file it mutated (drives file churn). */
  readonly filePath?: string;
  /** Set only for a skill invocation: the slug of the skill the agent ran. */
  readonly skillName?: string;
}

function claudeEvent(
  base: ClaudeEventBase,
  eventType: string,
  spanPhase: SpanPhase,
  spanName: string,
  attributes: Record<string, string>,
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: base.timestamp,
    session_id: base.sessionId,
    harness: "claude",
    ...(base.model !== undefined ? { model: base.model } : {}),
    ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
    event_type: eventType,
    trace_id: traceIdFor(base.sessionId),
    span_phase: spanPhase,
    span_name: spanName,
    attributes,
  };
}

export function claudeSessionStart(base: ClaudeEventBase): RegimenEvent {
  return claudeEvent(base, "session.start", "start", "session", {});
}

export function claudeSessionEnd(
  base: ClaudeEventBase,
  nativeReason?: string,
): RegimenEvent {
  const attributes: Record<string, string> = {
    end_reason_normalized: normalizeClaudeEndReason(nativeReason),
  };
  if (nativeReason !== undefined) attributes.end_reason_native = nativeReason;
  return claudeEvent(base, "session.end", "end", "session", attributes);
}

/**
 * The per-session sequence attribute, set only on the rollout path. Two
 * conversation turns can share a millisecond timestamp (Claude writes the
 * thinking and the answer of one turn at the same captured millisecond), so
 * without a per-session ordinal their structural events hash identically and
 * `INSERT OR IGNORE` drops the second, breaking the anchor the content
 * projection resolves against. The reader passes the projection order; the hook
 * translator omits it (the hook path emits one event per captured moment).
 */
function seqAttribute(seq: number | undefined): Record<string, string> {
  return seq !== undefined ? { seq: String(seq) } : {};
}

export function claudeUserPrompt(
  base: ClaudeEventBase,
  seq?: number,
): RegimenEvent {
  return claudeEvent(
    base,
    "user_prompt",
    "point",
    "user_prompt",
    seqAttribute(seq),
  );
}

export function claudeAgentMessage(
  base: ClaudeEventBase,
  seq?: number,
): RegimenEvent {
  return claudeEvent(
    base,
    "agent.message",
    "point",
    "agent_message",
    seqAttribute(seq),
  );
}

export function claudeCompaction(
  base: ClaudeEventBase,
  trigger?: string,
): RegimenEvent {
  return claudeEvent(
    base,
    "compaction",
    "point",
    "compaction",
    trigger !== undefined ? { trigger } : {},
  );
}

function toolAttributes(span: ClaudeToolSpan): Record<string, string> {
  const attributes: Record<string, string> = {
    tool_name: span.toolName,
    tool_call_id: span.toolCallId,
  };
  if (span.filePath !== undefined) attributes.file_path = span.filePath;
  if (span.skillName !== undefined) attributes.skill_name = span.skillName;
  return attributes;
}

export function claudeToolPre(
  base: ClaudeEventBase,
  span: ClaudeToolSpan,
): RegimenEvent {
  return claudeEvent(
    base,
    "tool.pre",
    "start",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}

export function claudeToolPost(
  base: ClaudeEventBase,
  span: ClaudeToolSpan,
): RegimenEvent {
  return claudeEvent(
    base,
    "tool.post",
    "end",
    `tool:${span.toolName}`,
    toolAttributes(span),
  );
}
