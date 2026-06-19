/**
 * The Codex rollout transcript reader.
 *
 * Phase 1.4's version-proof fallback and judge-time transcript source. A
 * pure fold from one Codex rollout file's JSONL content to the same v1 event
 * vocabulary the Codex hook translator emits, so everything downstream (the
 * store, the signal projections, the evidence read side) is reused unchanged.
 */
import type { RegimenEvent } from "../../../hooks/event-log.ts";
import { eventHash } from "../../hash.ts";
import { readSkillName } from "../../envelope.ts";
import {
  codexAgentMessage,
  codexCompaction,
  codexSessionEnd,
  codexSessionStart,
  codexToolPost,
  codexToolPre,
  codexUserPrompt,
  type CodexEventBase,
} from "../translators/codex-events.ts";

/**
 * A reference from a content chunk back to the deterministic event that
 * justifies it, per ADR-0008. A tool chunk resolves through the
 * `tool_call_spans` PK; every other chunk resolves through the lowercase-hex
 * encoding of its structural event's `event_hash`.
 */
export type AnchorRef =
  | { readonly eventHash: string }
  | { readonly sessionId: string; readonly toolCallId: string };

/**
 * One unit of conversation text the judge reads, referenced by anchor and
 * never stored in the events DB. `text` is already extracted, filtered, and
 * truncated. `lineSeq` is the chunk's position in file line order, the
 * re-render-stable ordering key (timestamps collide; line order does not).
 */
export interface ContentChunk {
  readonly kind:
    | "human_prompt"
    | "assistant_answer"
    | "tool_args"
    | "tool_output"
    | "web_search_query";
  readonly text: string;
  readonly anchor: AnchorRef;
  readonly lineSeq: number;
}

export interface RolloutReadOptions {
  /**
   * When true, the transcript is treated as finished and a `session.end` is
   * appended at the last line's timestamp. The newest live rollout passes
   * false so an open conversation is never force-closed.
   */
  readonly complete: boolean;
}

/**
 * A load-bearing record the reader recognized but could not parse to a shape
 * it trusts, surfaced rather than best-effort parsed (ADR-0007). `rawLine` is
 * the verbatim JSONL line so a caller can route it to the quarantine store.
 */
export interface QuarantinedRecord {
  readonly reason: string;
  readonly rawLine: string;
}

/**
 * One whole-transcript read: the structural events, the content projection,
 * and the ADR-0007 fail-closed diagnostics. `unknownRecordTypes` counts each
 * `(type, payload.type)` the reader has never seen, keyed `type/payloadType`,
 * so benign vendor drift stays visible without failing a readable transcript.
 * `quarantined` holds load-bearing records whose fields did not match a known
 * shape (an unknown message role, an unknown content-part type).
 */
export interface RolloutReadResult {
  readonly events: RegimenEvent[];
  readonly content: ContentChunk[];
  readonly unknownRecordTypes: Record<string, number>;
  readonly quarantined: QuarantinedRecord[];
}

interface RolloutLine {
  readonly type: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

function parseLine(raw: string): RolloutLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string" || typeof obj.timestamp !== "string") {
    return undefined;
  }
  const payload =
    typeof obj.payload === "object" && obj.payload !== null
      ? (obj.payload as Record<string, unknown>)
      : {};
  return { type: obj.type, timestamp: obj.timestamp, payload };
}

const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;

/**
 * The files an `apply_patch` touches, read from its patch headers. The patch
 * text (in the tool call's `input`) is the source of file churn that is
 * present on every Codex build, where the `patch_apply_end` event is not.
 */
export function applyPatchFilePaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split("\n")) {
    const match = PATCH_FILE_HEADER.exec(line);
    if (match !== null) paths.push(match[1]!.trim());
  }
  return paths;
}

/**
 * The skill slug a rollout tool call invoked, or undefined when it is not a
 * skill invocation. A rollout call serializes its input as a JSON string
 * (function_call `arguments`) or a raw string (custom_tool_call `input`, e.g.
 * apply_patch's patch text, which is not JSON). Only the JSON object form
 * names a skill; the field read is delegated to the shared `readSkillName` so
 * the rollout and hook paths cannot disagree on where skill identity lives.
 */
function rolloutSkillName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return readSkillName(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function rolloutEvents(
  content: string,
  options: RolloutReadOptions,
): RegimenEvent[] {
  const events: RegimenEvent[] = [];
  let sessionId = "unknown";
  let currentModel: string | undefined;
  let currentCwd: string | undefined;
  let lastTimestamp: string | undefined;
  let webSearchSeq = 0;
  let structuralSeq = 0;
  let sessionVscode = false;
  let sessionSubagent = false;
  const toolNameByCallId = new Map<string, string>();

  const base = (timestamp: string): CodexEventBase => ({
    sessionId,
    timestamp,
    model: currentModel,
    cwd: currentCwd,
  });

  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const line = parseLine(raw);
    if (line === undefined) continue;
    lastTimestamp = line.timestamp;

    if (line.type === "session_meta") {
      sessionId =
        typeof line.payload.id === "string" ? line.payload.id : sessionId;
      if (typeof line.payload.cwd === "string") {
        currentCwd = line.payload.cwd;
      }
      const classified = classifySession(line.payload);
      sessionVscode = classified.vscode;
      sessionSubagent = classified.subagent;
      events.push(codexSessionStart(base(line.timestamp)));
    } else if (line.type === "turn_context") {
      if (typeof line.payload.model === "string") {
        currentModel = line.payload.model;
      }
      if (typeof line.payload.cwd === "string") {
        currentCwd = line.payload.cwd;
      }
    } else if (line.type === "event_msg") {
      // The `event_msg` user_message is the dedup twin of the canonical
      // `response_item` user message the content fold reads, so user_prompt is
      // minted from the response_item pass below (with the seq the content
      // anchor targets), never from this stream. context_compacted has no
      // response_item twin, so it stays the compaction source here.
      const payloadType = line.payload.type;
      if (payloadType === "context_compacted") {
        events.push(codexCompaction(base(line.timestamp)));
      }
    } else if (line.type === "response_item") {
      const payloadType = line.payload.type;
      const message = projectedMessage(line, {
        vscode: sessionVscode,
        subagent: sessionSubagent,
      });
      if (message !== undefined) {
        // The same post-injection-filter conversation turns the content fold
        // projects, carrying the same per-session structuralSeq, so each
        // user_prompt/agent.message hash matches its content anchor exactly.
        const seq = structuralSeq;
        structuralSeq += 1;
        events.push(
          message.kind === "human_prompt"
            ? codexUserPrompt(base(line.timestamp), seq)
            : codexAgentMessage(base(line.timestamp), seq),
        );
        continue;
      }
      if (payloadType === "web_search_call") {
        // A web search has no call_id and no separate end line: it is logged
        // once, already completed. Emit a self-paired span so it counts as a
        // tool use, keyed by a per-session sequence for a stable id.
        const action = line.payload.action;
        const query =
          typeof action === "object" &&
          action !== null &&
          typeof (action as Record<string, unknown>).query === "string"
            ? ((action as Record<string, unknown>).query as string)
            : undefined;
        const span = {
          toolName: "web_search",
          toolCallId: `web_search:${webSearchSeq}`,
          ...(query !== undefined ? { query } : {}),
        };
        webSearchSeq += 1;
        events.push(codexToolPre(base(line.timestamp), span));
        events.push(codexToolPost(base(line.timestamp), span));
        continue;
      }
      const callId =
        typeof line.payload.call_id === "string"
          ? line.payload.call_id
          : undefined;
      if (
        (payloadType === "function_call" ||
          payloadType === "custom_tool_call") &&
        callId !== undefined
      ) {
        const toolName =
          typeof line.payload.name === "string" ? line.payload.name : "unknown";
        toolNameByCallId.set(callId, toolName);
        const skillName = rolloutSkillName(
          line.payload.arguments ?? line.payload.input,
        );
        events.push(
          codexToolPre(base(line.timestamp), {
            toolName,
            toolCallId: callId,
            ...(skillName !== undefined ? { skillName } : {}),
          }),
        );
        if (
          toolName === "apply_patch" &&
          typeof line.payload.input === "string"
        ) {
          for (const filePath of applyPatchFilePaths(line.payload.input)) {
            events.push(
              codexToolPost(base(line.timestamp), {
                toolName,
                toolCallId: callId,
                filePath,
              }),
            );
          }
        }
      } else if (
        (payloadType === "function_call_output" ||
          payloadType === "custom_tool_call_output") &&
        callId !== undefined
      ) {
        const toolName = toolNameByCallId.get(callId) ?? "unknown";
        events.push(
          codexToolPost(base(line.timestamp), {
            toolName,
            toolCallId: callId,
          }),
        );
      }
    }
  }

  if (options.complete && lastTimestamp !== undefined) {
    events.push(codexSessionEnd(base(lastTimestamp)));
  }

  return events;
}

/** Parse a tool call's JSON `arguments` string into an object, or undefined. */
function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text of a tool call's arguments the judge reads, extracted per tool so a
 * judge sees the command, not the control envelope. Returns undefined when the
 * call carries no judge-relevant argument text (an empty `write_stdin`, or a
 * tool whose argument shape is not yet recognized), so the caller emits no
 * chunk rather than fabricating one.
 *   - `exec_command` -> `args.cmd` (string)
 *   - `shell` (OLDEST) -> `args.command` (string array, space-joined)
 *   - `apply_patch` -> raw `.input` patch text
 *   - `write_stdin` -> `args.chars` (skipped when empty; the session_id /
 *     yield_time_ms / max_output_tokens siblings are control noise)
 */
function toolArgsText(
  toolName: string,
  argumentsRaw: unknown,
  inputRaw: unknown,
): string | undefined {
  if (toolName === "apply_patch") {
    return typeof inputRaw === "string" && inputRaw.length > 0
      ? inputRaw
      : undefined;
  }
  const args = parseArgs(argumentsRaw);
  if (args === undefined) return undefined;
  if (toolName === "exec_command") {
    return typeof args.cmd === "string" ? args.cmd : undefined;
  }
  if (toolName === "shell") {
    return Array.isArray(args.command)
      ? args.command.filter((c) => typeof c === "string").join(" ")
      : undefined;
  }
  if (toolName === "write_stdin") {
    return typeof args.chars === "string" && args.chars.length > 0
      ? args.chars
      : undefined;
  }
  return undefined;
}

/**
 * The text of a tool result's `.output`, unwrapping the OLDEST JSON-wrapped
 * form without keying on build version. The rule: try to parse the output as
 * JSON; if it is an object carrying its own `.output` string, use that; else
 * the output is already the raw result text.
 */
function unwrapToolOutput(output: string): string {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).output === "string"
    ) {
      return (parsed as Record<string, unknown>).output as string;
    }
  } catch {
    // Not JSON: the output is the raw result text.
  }
  return output;
}

/**
 * The head+tail byte budget for tool output. Tool results run to tens of
 * kilobytes; the judge needs the shape of a result, not every byte. The exact
 * budget is the assess step's to tune (ADR-0008 / discovery section 9); this
 * is the reader's honest default.
 */
const TOOL_OUTPUT_HEAD = 2000;
const TOOL_OUTPUT_TAIL = 2000;

/**
 * Truncate over-budget text head+tail, marking the elision so the judge reads
 * "large output elided" rather than mistaking a truncation for an empty
 * result. Honest over tidy: the dropped span is named, never silently removed.
 */
function truncateHeadTail(text: string): string {
  if (text.length <= TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL) return text;
  const head = text.slice(0, TOOL_OUTPUT_HEAD);
  const tail = text.slice(text.length - TOOL_OUTPUT_TAIL);
  const elided = text.length - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL;
  return `${head}\n[... ${elided} characters elided ...]\n${tail}`;
}

/** The text of a `message` record's content parts of one part type. */
function partsText(content: unknown, partType: string): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === partType &&
      typeof (part as Record<string, unknown>).text === "string"
    ) {
      texts.push((part as Record<string, unknown>).text as string);
    }
  }
  return texts.join("");
}

function hashHex(event: RegimenEvent): string {
  return eventHash(event).toString("hex");
}

/** The leading marker that identifies an IDE-wrapped engineer prompt. */
const IDE_WRAPPER_PREFIX = "# Context from my IDE setup:";

/**
 * The leading markers of context the harness injects into a user-role record
 * regardless of session originator: an `<environment_context>` block, an
 * AGENTS.md instruction dump, and the guardian's agent-history replay. None is
 * engineer prose, so each is excluded from the judge's input in every session
 * (a CLI session can carry an `<environment_context>` injection too).
 */
const MACHINE_INJECTION_PREFIXES = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "The following is the Codex agent history",
];

/**
 * Whether a user-role message is machine-injected context to exclude, given
 * whether the session is one whose engineer prose rides an IDE wrapper (vscode)
 * or whose whole population is non-human (a subagent replaying agent history).
 * Fail-closed toward exclusion:
 *   - The pure-injection markers are excluded in every session.
 *   - A subagent session's whole user population is non-human.
 *   - A vscode session includes a user message only when it is positively the
 *     IDE wrapper carrying the engineer's ask (boundary marked, never silently
 *     stripped); anything else defaults to exclude.
 *   - A plain CLI session includes a user message that is not a pure injection.
 */
function isInjectedUserMessage(
  text: string,
  session: { vscode: boolean; subagent: boolean },
): boolean {
  if (MACHINE_INJECTION_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return true;
  }
  if (session.subagent) return true;
  if (session.vscode) return !text.startsWith(IDE_WRAPPER_PREFIX);
  return false;
}

/** A session's injection-filter inputs, threaded from its `session_meta`. */
interface SessionClassification {
  readonly vscode: boolean;
  readonly subagent: boolean;
}

/**
 * Whether the session's originator/source mark it as one whose user-role
 * messages must pass the injection filter (vscode), or whose whole population
 * is non-human (a subagent like the guardian replaying agent history).
 */
function classifySession(
  payload: Record<string, unknown>,
): SessionClassification {
  const originator = payload.originator;
  const source = payload.source;
  const vscode = originator === "codex_vscode" || source === "vscode";
  const subagent =
    typeof source === "object" &&
    source !== null &&
    typeof (source as Record<string, unknown>).subagent === "object" &&
    (source as Record<string, unknown>).subagent !== null;
  return { vscode, subagent };
}

/**
 * The conversation message a `response_item` projects, or `undefined` when the
 * record is not a projected message (an injected user message, or a non-message
 * record). The single decision both folds share: which records become anchored
 * conversation turns, and the order they consume the per-session `seq`. The
 * structural fold mints the `user_prompt`/`agent.message` event; the content
 * fold projects the `human_prompt`/`assistant_answer` chunk; both read the same
 * `kind`, `text`, and (via the caller's running counter) the same `seq`, so a
 * chunk's anchor and its event hash to the same digest.
 */
function projectedMessage(
  line: RolloutLine,
  session: SessionClassification,
):
  | { readonly kind: "human_prompt"; readonly text: string }
  | { readonly kind: "assistant_answer"; readonly text: string }
  | undefined {
  if (line.payload.type !== "message") return undefined;
  if (line.payload.role === "user") {
    const text = partsText(line.payload.content, "input_text");
    if (isInjectedUserMessage(text, session)) return undefined;
    return { kind: "human_prompt", text };
  }
  if (line.payload.role === "assistant") {
    return {
      kind: "assistant_answer",
      text: partsText(line.payload.content, "output_text"),
    };
  }
  return undefined;
}

/**
 * The content projection: the conversation text the judge reads, anchored to
 * the structural events `rolloutContent` derives and never stored in the DB.
 * A sibling pass over the same parsed lines and the same record recognition,
 * so the canonical-stream and anchor rules cannot drift from the event fold.
 */
export function rolloutContent(content: string): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let sessionId = "unknown";
  let currentModel: string | undefined;
  let currentCwd: string | undefined;
  let lineSeq = 0;
  let structuralSeq = 0;
  let webSearchSeq = 0;
  let sessionVscode = false;
  let sessionSubagent = false;

  const base = (timestamp: string): CodexEventBase => ({
    sessionId,
    timestamp,
    model: currentModel,
    cwd: currentCwd,
  });

  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const line = parseLine(raw);
    if (line === undefined) continue;

    if (line.type === "session_meta") {
      sessionId =
        typeof line.payload.id === "string" ? line.payload.id : sessionId;
      if (typeof line.payload.cwd === "string") currentCwd = line.payload.cwd;
      const classified = classifySession(line.payload);
      sessionVscode = classified.vscode;
      sessionSubagent = classified.subagent;
      continue;
    }
    if (line.type === "turn_context") {
      if (typeof line.payload.model === "string") {
        currentModel = line.payload.model;
      }
      if (typeof line.payload.cwd === "string") currentCwd = line.payload.cwd;
      continue;
    }
    if (line.type !== "response_item") continue;

    if (line.payload.type === "web_search_call") {
      // Mirror the structural fold's self-pairing: every web_search_call
      // consumes a webSearchSeq (so the anchor's span id stays aligned), but
      // only the `search` action carries a query to project. `open_page` has
      // none.
      const action = line.payload.action;
      const query =
        typeof action === "object" &&
        action !== null &&
        typeof (action as Record<string, unknown>).query === "string"
          ? ((action as Record<string, unknown>).query as string)
          : undefined;
      const span = {
        toolName: "web_search",
        toolCallId: `web_search:${webSearchSeq}`,
        ...(query !== undefined ? { query } : {}),
      };
      webSearchSeq += 1;
      if (query !== undefined) {
        chunks.push({
          kind: "web_search_query",
          text: query,
          anchor: {
            eventHash: hashHex(codexToolPre(base(line.timestamp), span)),
          },
          lineSeq,
        });
        lineSeq += 1;
      }
      continue;
    }

    const message = projectedMessage(line, {
      vscode: sessionVscode,
      subagent: sessionSubagent,
    });
    if (message !== undefined) {
      // The same conversation turns the structural fold mints events for,
      // consuming the per-session seq in the same order so this chunk's anchor
      // reproduces that event's hash exactly.
      const seq = structuralSeq;
      structuralSeq += 1;
      const anchorEvent =
        message.kind === "human_prompt"
          ? codexUserPrompt(base(line.timestamp), seq)
          : codexAgentMessage(base(line.timestamp), seq);
      chunks.push({
        kind: message.kind,
        text: message.text,
        anchor: { eventHash: hashHex(anchorEvent) },
        lineSeq,
      });
      lineSeq += 1;
    } else if (
      line.payload.type === "function_call" ||
      line.payload.type === "custom_tool_call"
    ) {
      const callId =
        typeof line.payload.call_id === "string"
          ? line.payload.call_id
          : undefined;
      const toolName =
        typeof line.payload.name === "string" ? line.payload.name : "unknown";
      if (callId !== undefined) {
        const text = toolArgsText(
          toolName,
          line.payload.arguments,
          line.payload.input,
        );
        if (text !== undefined) {
          chunks.push({
            kind: "tool_args",
            text,
            anchor: { sessionId, toolCallId: callId },
            lineSeq,
          });
          lineSeq += 1;
        }
      }
    } else if (
      line.payload.type === "function_call_output" ||
      line.payload.type === "custom_tool_call_output"
    ) {
      const callId =
        typeof line.payload.call_id === "string"
          ? line.payload.call_id
          : undefined;
      if (callId !== undefined && typeof line.payload.output === "string") {
        const text = truncateHeadTail(unwrapToolOutput(line.payload.output));
        chunks.push({
          kind: "tool_output",
          text,
          anchor: { sessionId, toolCallId: callId },
          lineSeq,
        });
        lineSeq += 1;
      }
    }
  }

  return chunks;
}

/**
 * The record shapes the reader recognizes, by `(type, payload.type)`. A record
 * matching one of these is handled (projected, deduped, or recognized-and-
 * excluded); a record outside this set is counted as an unknown type. The
 * top-level `compacted` and `session_meta`/`turn_context` records carry no
 * `payload.type`, so they are recognized by `type` alone.
 */
const KNOWN_EVENT_MSG_TYPES = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "token_count",
  "task_started",
  "task_complete",
  "patch_apply_end",
  "exec_command_end",
  "web_search_end",
  "guardian_assessment",
  "error",
  "thread_name_updated",
  "turn_aborted",
]);
const KNOWN_RESPONSE_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
]);
const KNOWN_TOP_LEVEL_TYPES = new Set([
  "session_meta",
  "turn_context",
  "compacted",
]);
/** The message roles the reader knows how to route. */
const KNOWN_MESSAGE_ROLES = new Set(["user", "assistant", "developer"]);
/** The content-part types the reader knows how to read. */
const KNOWN_PART_TYPES = new Set(["input_text", "output_text"]);

/**
 * Recognize one parsed line by shape, accumulating ADR-0007 diagnostics.
 * Returns the unknown-type key to count (when the record type is unseen),
 * a quarantine reason (when a load-bearing record's fields are unrecognized),
 * or neither (a known, well-formed record). A `message` is load-bearing: an
 * unknown role or an unseen content-part type is quarantined, never parsed
 * past into fabricated text.
 */
function recognize(
  line: RolloutLine,
): { unknownKey: string } | { quarantineReason: string } | undefined {
  if (KNOWN_TOP_LEVEL_TYPES.has(line.type)) return undefined;
  const payloadType =
    typeof line.payload.type === "string" ? line.payload.type : undefined;

  if (line.type === "event_msg") {
    if (payloadType !== undefined && KNOWN_EVENT_MSG_TYPES.has(payloadType)) {
      return undefined;
    }
    return { unknownKey: `event_msg/${payloadType ?? "(none)"}` };
  }

  if (line.type === "response_item") {
    if (
      payloadType === undefined ||
      !KNOWN_RESPONSE_ITEM_TYPES.has(payloadType)
    ) {
      return { unknownKey: `response_item/${payloadType ?? "(none)"}` };
    }
    if (payloadType === "message") {
      const role = line.payload.role;
      if (typeof role !== "string" || !KNOWN_MESSAGE_ROLES.has(role)) {
        return {
          quarantineReason: `response_item/message with unknown role ${String(role)}`,
        };
      }
      const content = line.payload.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const partType =
            typeof part === "object" && part !== null
              ? (part as Record<string, unknown>).type
              : undefined;
          if (typeof partType !== "string" || !KNOWN_PART_TYPES.has(partType)) {
            return {
              quarantineReason: `response_item/message ${role} with unknown content part ${String(partType)}`,
            };
          }
        }
      }
    }
    return undefined;
  }

  return { unknownKey: `${line.type}/${payloadType ?? "(none)"}` };
}

/**
 * The whole-transcript read with ADR-0007 fail-closed diagnostics: the
 * structural events, the content projection, the unknown-record-type counts,
 * and the quarantined load-bearing records, in one result. The convenience
 * `rolloutEvents` / `rolloutContent` wrappers project the first two fields for
 * callers that do not need the diagnostics.
 */
export function rolloutRead(
  content: string,
  options: RolloutReadOptions,
): RolloutReadResult {
  const unknownRecordTypes: Record<string, number> = {};
  const quarantined: QuarantinedRecord[] = [];

  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const parsed = parseLine(raw);
    if (parsed === undefined) continue;
    const verdict = recognize(parsed);
    if (verdict === undefined) continue;
    if ("unknownKey" in verdict) {
      unknownRecordTypes[verdict.unknownKey] =
        (unknownRecordTypes[verdict.unknownKey] ?? 0) + 1;
    } else {
      quarantined.push({ reason: verdict.quarantineReason, rawLine: raw });
    }
  }

  return {
    events: rolloutEvents(content, options),
    content: rolloutContent(content),
    unknownRecordTypes,
    quarantined,
  };
}
