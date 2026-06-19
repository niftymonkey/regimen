/**
 * The Codex translator: one envelope to one canonical v1 event.
 *
 * Pure function from an envelope produced by the Codex capture hook to a v1
 * event the loader writes to the events table, the Codex counterpart of the
 * Claude translator. Per ADR-0006 the translator registry is the only
 * harness-specific seam in the loader, so adding Codex is this one file plus
 * one map entry.
 *
 * It maps the five Codex hook events the capture hook wires (SessionStart,
 * UserPromptSubmit, PreToolUse, PostToolUse, PreCompact). Tool spans pair by
 * `tool_use_id`, matching the Claude contract. The v1 events are built with
 * the shared Codex vocabulary in `codex-events.ts`, the single source of
 * truth this translator and the rollout reader both emit through, so the
 * real-time hook path and the rollout fallback cannot drift.
 *
 * Two honest divergences from Claude, both rooted in Codex's hook surface:
 *   - Codex has no session-end hook (its `Stop`/`SubagentStop` are turn-scoped,
 *     not session-scoped), so this translator never emits `session.end`. That
 *     boundary, when needed, comes from the rollout tailer, not from hooks.
 *   - Codex edits run through `apply_patch` with `tool_input.command` holding
 *     the patch text, not an `Edit` tool exposing `tool_input.file_path`, so no
 *     reliable `file_path` attribute is derivable from the hook payload. Per
 *     file churn for Codex is left to the rollout reader rather than parsed out
 *     of the patch here.
 *
 * The translator returns:
 *   - `{ kind: "event" }` for a mapped hook event.
 *   - `{ kind: "skip" }` for a valid Codex hook event with no v1 mapping (for
 *     example `Stop`, `PostCompact`, or `PermissionRequest` today). Adding a
 *     mapping later is purely additive.
 *   - `{ kind: "quarantine" }` when the payload is malformed enough that no
 *     trustworthy event can be derived (not an object, or no `hook_event_name`).
 */
import { type RegimenEvent } from "../../../hooks/event-log.ts";
import {
  readSkillName,
  readString,
  type Envelope,
  type TranslateResult,
} from "../../envelope.ts";
import {
  codexCompaction,
  codexSessionStart,
  codexToolPost,
  codexToolPre,
  codexUserPrompt,
  type CodexEventBase,
  type CodexToolSpan,
} from "./codex-events.ts";

/** Codex hook event name -> the v1 `event_type` it maps to. */
const EVENT_TYPE: Readonly<Record<string, string>> = {
  SessionStart: "session.start",
  UserPromptSubmit: "user_prompt",
  PreToolUse: "tool.pre",
  PostToolUse: "tool.post",
  PreCompact: "compaction",
};

function toolSpan(
  payload: Record<string, unknown>,
  fallbackCallId: string,
): CodexToolSpan {
  const skillName = readSkillName(payload.tool_input);
  return {
    toolName: readString(payload, "tool_name") ?? "unknown",
    toolCallId: readString(payload, "tool_use_id") ?? fallbackCallId,
    ...(skillName !== undefined ? { skillName } : {}),
  };
}

export function translateCodex(envelope: Envelope): TranslateResult {
  if (typeof envelope.payload !== "object" || envelope.payload === null) {
    return { kind: "quarantine", reason: "codex payload is not an object" };
  }
  const payload = envelope.payload as Record<string, unknown>;
  const hookEventName = readString(payload, "hook_event_name");
  if (hookEventName === undefined) {
    return {
      kind: "quarantine",
      reason: "codex payload missing hook_event_name",
    };
  }
  const eventType = EVENT_TYPE[hookEventName];
  if (eventType === undefined) return { kind: "skip" };

  const base: CodexEventBase = {
    sessionId: readString(payload, "session_id") ?? "unknown",
    timestamp: envelope.captured_at,
    model: readString(payload, "model"),
    cwd: readString(payload, "cwd"),
  };

  let event: RegimenEvent;
  switch (eventType) {
    case "session.start":
      event = codexSessionStart(base);
      break;
    case "user_prompt":
      event = codexUserPrompt(base);
      break;
    case "compaction":
      event = codexCompaction(base, readString(payload, "trigger"));
      break;
    case "tool.pre":
      event = codexToolPre(base, toolSpan(payload, base.timestamp));
      break;
    default:
      event = codexToolPost(base, toolSpan(payload, base.timestamp));
      break;
  }
  return { kind: "event", event };
}
