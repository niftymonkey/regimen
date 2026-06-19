/**
 * The Claude Code translator: one envelope to one canonical v1 event.
 *
 * Pure function from an envelope produced by the Claude capture hook to a
 * v1 event the loader writes to the events table. Pre-cutover this logic
 * lived in `hooks/capture.ts` and ran inside the agent's process on every
 * event; ADR-0006 moved it here so the hook stays trivially small and
 * schema-mapping logic lives in our codebase where it is testable.
 *
 * The translator returns:
 *   - `{ kind: "event" }` for the five hook events the schema maps
 *     (SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse).
 *   - `{ kind: "skip" }` for valid Claude hook events with no v1 mapping
 *     (for example, Notification or PreCompact today). Adding a mapping for
 *     one of these later is purely additive and does not change this contract.
 *   - `{ kind: "quarantine" }` when the payload is malformed enough that
 *     no trustworthy event can be derived (no `hook_event_name`).
 */
import { traceIdFor } from "@regimen/shared";
import { type SpanPhase } from "../../../hooks/event-log.ts";
import {
  readSkillName,
  readString,
  type Envelope,
  type TranslateResult,
} from "../../envelope.ts";
import { normalizeClaudeEndReason } from "./end-reason.ts";

/** Claude hook event name -> v1 `event_type` and the span phase it marks. */
interface Mapping {
  readonly eventType: string;
  readonly spanPhase: SpanPhase;
}

const EVENT_MAP: Readonly<Record<string, Mapping>> = {
  SessionStart: { eventType: "session.start", spanPhase: "start" },
  SessionEnd: { eventType: "session.end", spanPhase: "end" },
  UserPromptSubmit: { eventType: "user_prompt", spanPhase: "point" },
  PreToolUse: { eventType: "tool.pre", spanPhase: "start" },
  PostToolUse: { eventType: "tool.post", spanPhase: "end" },
  PreCompact: { eventType: "compaction", spanPhase: "point" },
};

export function translateClaude(envelope: Envelope): TranslateResult {
  if (typeof envelope.payload !== "object" || envelope.payload === null) {
    return { kind: "quarantine", reason: "claude payload is not an object" };
  }
  const payload = envelope.payload as Record<string, unknown>;
  const hookEventName = readString(payload, "hook_event_name");
  if (hookEventName === undefined) {
    return {
      kind: "quarantine",
      reason: "claude payload missing hook_event_name",
    };
  }
  const mapping = EVENT_MAP[hookEventName];
  if (mapping === undefined) return { kind: "skip" };

  const sessionId = readString(payload, "session_id") ?? "unknown";
  const model = readString(payload, "model");
  const cwd = readString(payload, "cwd");
  const timestamp = envelope.captured_at;

  const attributes: Record<string, string> = {};
  let spanName: string;
  if (mapping.eventType === "session.end") {
    spanName = "session";
    const nativeReason = readString(payload, "reason");
    if (nativeReason !== undefined) {
      attributes.end_reason_native = nativeReason;
    }
    attributes.end_reason_normalized = normalizeClaudeEndReason(nativeReason);
  } else if (mapping.eventType === "session.start") {
    spanName = "session";
  } else if (mapping.eventType === "user_prompt") {
    spanName = "user_prompt";
  } else if (mapping.eventType === "compaction") {
    spanName = "compaction";
    const trigger = readString(payload, "trigger");
    if (trigger !== undefined) attributes.trigger = trigger;
  } else {
    const toolName = readString(payload, "tool_name") ?? "unknown";
    attributes.tool_name = toolName;
    attributes.tool_call_id = readString(payload, "tool_use_id") ?? timestamp;
    const toolInput = payload.tool_input;
    if (
      typeof toolInput === "object" &&
      toolInput !== null &&
      "file_path" in toolInput &&
      typeof toolInput.file_path === "string" &&
      toolInput.file_path.length > 0
    ) {
      attributes.file_path = toolInput.file_path;
    }
    const skillName = readSkillName(toolInput);
    if (skillName !== undefined) attributes.skill_name = skillName;
    spanName = `tool:${toolName}`;
  }

  return {
    kind: "event",
    event: {
      schema_version: 1,
      timestamp,
      session_id: sessionId,
      harness: "claude",
      ...(model !== undefined ? { model } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      event_type: mapping.eventType,
      trace_id: traceIdFor(sessionId),
      span_phase: mapping.spanPhase,
      span_name: spanName,
      attributes,
    },
  };
}
