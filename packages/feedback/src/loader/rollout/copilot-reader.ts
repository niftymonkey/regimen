/**
 * The GitHub Copilot CLI transcript reader.
 *
 * The judge-time transcript source for the Copilot harness, the sibling of the
 * Codex and Claude rollout readers: a pure fold from one Copilot session's
 * `events.jsonl` content to the same harness-neutral RolloutReadResult (the v1
 * event vocabulary plus the content projection), so everything downstream (the
 * store, the signal projections, the evidence read side) is reused unchanged.
 *
 * Copilot writes plain one-event-per-line JSONL under a uniform envelope
 * `{type, id, timestamp, parentId, data}`. The fold is a straight line-by-line
 * pass with no `$set` patches or rollout dedup. The conversation lines are
 * `user.message`, `assistant.message`, and the paired `tool.execution_start` /
 * `tool.execution_complete`; the session is opened at the first conversation
 * line and closed at the last when `complete` is true (Copilot also writes a
 * real `session.shutdown` record, but the reader honors `complete` so an open
 * live transcript is never force-closed, matching the Claude reader).
 */
import type { RegimenEvent } from "../../../hooks/event-log.ts";
import { eventHash } from "../../hash.ts";
import type {
  ContentChunk,
  RolloutReadOptions,
  RolloutReadResult,
} from "../reader-types.ts";
import {
  copilotAgentMessage,
  copilotSessionEnd,
  copilotSessionStart,
  copilotToolPost,
  copilotToolPre,
  copilotUserPrompt,
  type CopilotEventBase,
} from "../translators/copilot-events.ts";

/**
 * The record types the reader projects to events or content. Copilot writes
 * many record types (session.start, session.model_change, system.message, the
 * assistant.turn_start/turn_end pair, hook.start/hook.end, permission.*); only
 * the conversation-bearing lines below carry judge content. The session is
 * opened at the first such line and closed at the last (honoring `complete`).
 */
function isConversationLine(type: string): boolean {
  return (
    type === "user.message" ||
    type === "assistant.message" ||
    type === "tool.execution_start" ||
    type === "tool.execution_complete"
  );
}

interface CopilotLine {
  readonly type: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

function parseLine(raw: string): CopilotLine | undefined {
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
  const data =
    typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : {};
  return { type: obj.type, timestamp: obj.timestamp, data };
}

/**
 * The session id carried across a whole transcript. Copilot stamps the id only
 * on `session.start.data.sessionId`; the conversation lines do not repeat it,
 * so the reader latches it from the start record (or its first appearance) and
 * stamps every event with it.
 */
function readSessionId(lines: CopilotLine[]): string {
  for (const line of lines) {
    const id = line.data.sessionId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "unknown";
}

/** A non-empty string field of a data record, or undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The visible assistant answer text of an `assistant.message`: the plaintext
 * `data.content` only. The sibling `data.reasoningOpaque` (chain-of-thought)
 * and `data.encryptedContent` (an encrypted copy of the answer) are ENCRYPTED
 * and must never be projected, so the reader reads `content` and nothing else.
 * An empty string is a tool-only turn (the answer is the tool call, not prose).
 */
function assistantContentText(data: Record<string, unknown>): string {
  return typeof data.content === "string" ? data.content : "";
}

function copilotEvents(
  lines: CopilotLine[],
  sessionId: string,
  options: RolloutReadOptions,
): RegimenEvent[] {
  const events: RegimenEvent[] = [];
  let structuralSeq = 0;
  const toolNameByCallId = new Map<string, string>();
  let started = false;
  let lastBase: CopilotEventBase | undefined;

  for (const line of lines) {
    if (!isConversationLine(line.type)) continue;

    const model =
      typeof line.data.model === "string" ? line.data.model : undefined;
    const base: CopilotEventBase = {
      sessionId,
      timestamp: line.timestamp,
      model,
    };
    if (!started) {
      started = true;
      events.push(copilotSessionStart(base));
    }
    lastBase = base;

    if (line.type === "user.message") {
      const seq = structuralSeq;
      structuralSeq += 1;
      events.push(copilotUserPrompt(base, seq));
    } else if (line.type === "assistant.message") {
      if (assistantContentText(line.data).length > 0) {
        const seq = structuralSeq;
        structuralSeq += 1;
        events.push(copilotAgentMessage(base, seq));
      }
    } else if (line.type === "tool.execution_start") {
      const callId = readString(line.data.toolCallId);
      const toolName = readString(line.data.toolName) ?? "unknown";
      if (callId !== undefined) {
        toolNameByCallId.set(callId, toolName);
        events.push(copilotToolPre(base, { toolName, toolCallId: callId }));
      }
    } else if (line.type === "tool.execution_complete") {
      const callId = readString(line.data.toolCallId);
      if (callId !== undefined) {
        const toolName = toolNameByCallId.get(callId) ?? "unknown";
        events.push(copilotToolPost(base, { toolName, toolCallId: callId }));
      }
    }
  }

  if (options.complete && lastBase !== undefined) {
    events.push(copilotSessionEnd(lastBase));
  }

  return events;
}

function hashHex(event: RegimenEvent): string {
  return eventHash(event).toString("hex");
}

/**
 * The judge-relevant text of a tool call's arguments, extracted per tool so the
 * judge sees the command, not the control envelope. Returns undefined when the
 * call carries no judge-relevant text, so the caller emits no chunk rather than
 * fabricating one. Mirrors the Claude/Codex readers' toolArgsText.
 *   - `bash` -> the command string (Copilot's shell tool is lowercase `bash`).
 */
function toolArgsText(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === "bash") {
    return readString(args.command);
  }
  return undefined;
}

/**
 * The plaintext output of a `tool.execution_complete`: `data.result.content`,
 * the visible tool output (`data.result.detailedContent` is similar and not
 * preferred). An object result with no string content yields the empty string.
 */
function toolResultText(data: Record<string, unknown>): string {
  const result = data.result;
  if (typeof result !== "object" || result === null) return "";
  const content = (result as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

/**
 * The head+tail byte budget for tool output. Tool results run to tens of
 * kilobytes; the judge needs the shape of a result, not every byte. Mirrors the
 * Claude/Codex readers' budget so all harnesses present tool output identically.
 */
const TOOL_OUTPUT_HEAD = 2000;
const TOOL_OUTPUT_TAIL = 2000;

function truncateHeadTail(text: string): string {
  if (text.length <= TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL) return text;
  const head = text.slice(0, TOOL_OUTPUT_HEAD);
  const tail = text.slice(text.length - TOOL_OUTPUT_TAIL);
  const elided = text.length - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL;
  return `${head}\n[... ${elided} characters elided ...]\n${tail}`;
}

/**
 * The content projection: the conversation text the judge reads, anchored to the
 * structural events `copilotEvents` derives and never stored in the DB. A
 * sibling pass over the same parsed lines and the same record recognition, so
 * the anchor rules cannot drift from the event fold (the seq order is identical).
 */
function copilotContent(
  lines: CopilotLine[],
  sessionId: string,
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let lineSeq = 0;
  let structuralSeq = 0;

  for (const line of lines) {
    if (!isConversationLine(line.type)) continue;

    const model =
      typeof line.data.model === "string" ? line.data.model : undefined;
    const base: CopilotEventBase = {
      sessionId,
      timestamp: line.timestamp,
      model,
    };

    if (line.type === "user.message") {
      const seq = structuralSeq;
      structuralSeq += 1;
      const text =
        readString(line.data.content) ??
        readString(line.data.transformedContent) ??
        "";
      chunks.push({
        kind: "human_prompt",
        text,
        anchor: { eventHash: hashHex(copilotUserPrompt(base, seq)) },
        lineSeq,
      });
      lineSeq += 1;
    } else if (line.type === "assistant.message") {
      const text = assistantContentText(line.data);
      if (text.length > 0) {
        const seq = structuralSeq;
        structuralSeq += 1;
        chunks.push({
          kind: "assistant_answer",
          text,
          anchor: { eventHash: hashHex(copilotAgentMessage(base, seq)) },
          lineSeq,
        });
        lineSeq += 1;
      }
    } else if (line.type === "tool.execution_start") {
      const callId = readString(line.data.toolCallId);
      const toolName = readString(line.data.toolName) ?? "unknown";
      if (callId !== undefined) {
        const args =
          typeof line.data.arguments === "object" &&
          line.data.arguments !== null
            ? (line.data.arguments as Record<string, unknown>)
            : {};
        const text = toolArgsText(toolName, args);
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
    } else if (line.type === "tool.execution_complete") {
      const callId = readString(line.data.toolCallId);
      if (callId !== undefined) {
        const text = truncateHeadTail(toolResultText(line.data));
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

export function copilotRead(
  content: string,
  options: RolloutReadOptions,
): RolloutReadResult {
  const lines: CopilotLine[] = [];
  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const parsed = parseLine(raw);
    if (parsed !== undefined) lines.push(parsed);
  }
  const sessionId = readSessionId(lines);
  return {
    events: copilotEvents(lines, sessionId, options),
    content: copilotContent(lines, sessionId),
    unknownRecordTypes: {},
    quarantined: [],
  };
}
