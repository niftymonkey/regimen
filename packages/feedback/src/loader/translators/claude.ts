/**
 * The Claude Code translator: one envelope to one canonical v1 event.
 *
 * Pure function from an envelope produced by the Claude capture hook to a
 * v1 event the loader writes to the events table. Pre-cutover this logic
 * lived in `hooks/capture.ts` and ran inside the agent's process on every
 * event; ADR-0006 moved it here so the hook stays trivially small and
 * schema-mapping logic lives in our codebase where it is testable.
 *
 * The v1 events are built with the shared Claude vocabulary in
 * `claude-events.ts`, the single source of truth this translator and the
 * Claude transcript reader both emit through, so the real-time hook path and
 * the judge-time reader cannot drift on event_type, span phase, span name,
 * harness stamp, or trace-id derivation.
 *
 * The translator returns:
 *   - `{ kind: "event" }` for the six hook events the schema maps
 *     (SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
 *     PreCompact).
 *   - `{ kind: "skip" }` for valid Claude hook events with no v1 mapping
 *     (for example, Notification or Stop today). Adding a mapping for one of
 *     these later is purely additive and does not change this contract.
 *   - `{ kind: "quarantine" }` when the payload is malformed enough that
 *     no trustworthy event can be derived (no `hook_event_name`).
 */
import { type RegimenEvent } from "../../../hooks/event-log.ts";
import {
  readSkillName,
  readString,
  type Envelope,
  type TranslateResult,
} from "../../envelope.ts";
import {
  claudeCompaction,
  claudeSessionEnd,
  claudeSessionStart,
  claudeToolPost,
  claudeToolPre,
  claudeUserPrompt,
  type ClaudeEventBase,
  type ClaudeToolSpan,
} from "./claude-events.ts";

/** Claude hook event name -> the v1 `event_type` it maps to. */
const EVENT_TYPE: Readonly<Record<string, string>> = {
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "user_prompt",
  PreToolUse: "tool.pre",
  PostToolUse: "tool.post",
  PreCompact: "compaction",
};

/** The file path a tool reported mutating, when the hook input names one. */
function toolFilePath(payload: Record<string, unknown>): string | undefined {
  const toolInput = payload.tool_input;
  if (
    typeof toolInput === "object" &&
    toolInput !== null &&
    "file_path" in toolInput &&
    typeof toolInput.file_path === "string" &&
    toolInput.file_path.length > 0
  ) {
    return toolInput.file_path;
  }
  return undefined;
}

function toolSpan(
  payload: Record<string, unknown>,
  fallbackCallId: string,
): ClaudeToolSpan {
  const filePath = toolFilePath(payload);
  const skillName = readSkillName(payload.tool_input);
  return {
    toolName: readString(payload, "tool_name") ?? "unknown",
    toolCallId: readString(payload, "tool_use_id") ?? fallbackCallId,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(skillName !== undefined ? { skillName } : {}),
  };
}

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
  const eventType = EVENT_TYPE[hookEventName];
  if (eventType === undefined) return { kind: "skip" };

  const base: ClaudeEventBase = {
    sessionId: readString(payload, "session_id") ?? "unknown",
    timestamp: envelope.captured_at,
    model: readString(payload, "model"),
    cwd: readString(payload, "cwd"),
  };

  let event: RegimenEvent;
  switch (eventType) {
    case "session.start":
      event = claudeSessionStart(base);
      break;
    case "session.end":
      event = claudeSessionEnd(base, readString(payload, "reason"));
      break;
    case "user_prompt":
      event = claudeUserPrompt(base);
      break;
    case "compaction":
      event = claudeCompaction(base, readString(payload, "trigger"));
      break;
    case "tool.pre":
      event = claudeToolPre(base, toolSpan(payload, base.timestamp));
      break;
    default:
      event = claudeToolPost(base, toolSpan(payload, base.timestamp));
      break;
  }
  return { kind: "event", event };
}
