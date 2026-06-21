/**
 * The Gemini CLI transcript reader.
 *
 * The judge-time transcript source for the Gemini harness, the sibling of the
 * Codex, Claude, and Copilot rollout readers: a pure fold from one Gemini
 * session's `chats/session-*.jsonl` content to the same harness-neutral
 * RolloutReadResult (the v1 event vocabulary plus the content projection), so
 * everything downstream (the store, the signal projections, the evidence read
 * side) is reused unchanged.
 *
 * Gemini's transcript is event-sourced `$set`-patch JSONL, not a plain message
 * append. The reader reconstructs the conversation by an id-deduped fold:
 *   - line 0 is a session-init record (`{sessionId, startTime, ...}`) that seeds
 *     the session id and an opening base for session.start.
 *   - a `$set` patch with a `messages` array UPSERTs each message by `id` (it
 *     carries a snapshot; on this build only the first injected `<session_context>`
 *     message, on other surfaces it may re-embed the full array).
 *   - a `$set` patch with only `lastUpdated` changes nothing.
 *   - an append message line (`{id, timestamp, type, content, ...}`) UPSERTs by
 *     `id`. The snapshot's message id is 32-hex and the append ids are UUIDs, so
 *     the upsert naturally includes both without duplication.
 * After the fold, the messages are iterated in insertion order to emit events
 * and content. A `gemini` message's `content` is the visible answer STRING (its
 * sibling `thoughts` reasoning array is excluded, like the Codex reader excludes
 * chain-of-thought and Claude excludes `thinking`); a `user` message's `content`
 * is an array of `{text}` (a human prompt) and `{functionResponse}` (a tool
 * result) parts. Gemini does not persist the structured tool CALL, only the
 * `functionResponse` round-trip, so a span's tool.pre and tool.post are both
 * synthesized from that single response (no `tool_args` chunk exists).
 */
import type { RegimenEvent } from "../../../hooks/event-log.ts";
import { eventHash } from "../../hash.ts";
import type {
  ContentChunk,
  RolloutReadOptions,
  RolloutReadResult,
} from "../reader-types.ts";
import {
  geminiAgentMessage,
  geminiSessionEnd,
  geminiSessionStart,
  geminiToolPost,
  geminiToolPre,
  geminiUserPrompt,
  type GeminiEventBase,
} from "../translators/gemini-events.ts";

/** One folded message, the union the event and content passes both read. */
interface GeminiMessage {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly content: unknown;
  readonly model?: string;
}

/** A non-empty string, or undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce one raw record's fields into a GeminiMessage, or undefined. */
function toMessage(obj: Record<string, unknown>): GeminiMessage | undefined {
  const id = readString(obj.id);
  const timestamp = readString(obj.timestamp);
  const type = readString(obj.type);
  if (id === undefined || timestamp === undefined || type === undefined) {
    return undefined;
  }
  return {
    id,
    timestamp,
    type,
    content: obj.content,
    model: readString(obj.model),
  };
}

/**
 * The session id carried across the transcript: the line-0 init record's
 * `sessionId`. Falls back to the first record that carries one, then to
 * `unknown`, so a malformed head never blocks the fold.
 */
function readSessionId(records: Record<string, unknown>[]): string {
  for (const record of records) {
    const id = record.sessionId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "unknown";
}

/**
 * The fold: reconstruct the conversation as an ordered, id-deduped message
 * list. A `Map<id, message>` is inserted in file order; a `$set.messages`
 * snapshot and an append message line both UPSERT by id. The init record, a
 * `$set` with only `lastUpdated`, and a parse failure contribute nothing.
 */
function foldMessages(records: Record<string, unknown>[]): {
  messages: GeminiMessage[];
  startTime?: string;
} {
  const byId = new Map<string, GeminiMessage>();
  const order: string[] = [];
  let startTime: string | undefined;

  const upsert = (message: GeminiMessage): void => {
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, message);
  };

  for (const record of records) {
    if (typeof record.sessionId === "string" && startTime === undefined) {
      startTime = readString(record.startTime);
    }
    const patch = asObject(record.$set);
    if (patch !== undefined) {
      if (Array.isArray(patch.messages)) {
        for (const raw of patch.messages) {
          const obj = asObject(raw);
          if (obj === undefined) continue;
          const message = toMessage(obj);
          if (message !== undefined) upsert(message);
        }
      }
      continue;
    }
    const message = toMessage(record);
    if (message !== undefined) upsert(message);
  }

  return {
    messages: order.map((id) => byId.get(id)!),
    startTime,
  };
}

/** The functionResponse parts of a `user` message's content array, in order. */
interface ToolResultPart {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: string;
}

function functionResponseParts(content: unknown): ToolResultPart[] {
  if (!Array.isArray(content)) return [];
  const parts: ToolResultPart[] = [];
  for (const rawPart of content) {
    const part = asObject(rawPart);
    const fn = asObject(part?.functionResponse);
    if (fn === undefined) continue;
    const toolCallId = readString(fn.id);
    const toolName = readString(fn.name);
    if (toolCallId === undefined || toolName === undefined) continue;
    parts.push({ toolCallId, toolName, output: functionResponseOutput(fn) });
  }
  return parts;
}

/**
 * The visible output of a functionResponse: `response.output` when present,
 * else `response.error` (a failed tool call carries an error, not an output),
 * else the empty string.
 */
function functionResponseOutput(fn: Record<string, unknown>): string {
  const response = asObject(fn.response);
  if (response === undefined) return "";
  const output = response.output;
  if (typeof output === "string") return output;
  const error = response.error;
  if (typeof error === "string") return error;
  return "";
}

/** The `{text}` parts of a `user` message's content array, joined in order. */
function userTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const rawPart of content) {
    const part = asObject(rawPart);
    if (part !== undefined && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts;
}

function geminiEvents(
  messages: GeminiMessage[],
  sessionId: string,
  startTime: string | undefined,
  options: RolloutReadOptions,
): RegimenEvent[] {
  const events: RegimenEvent[] = [];
  let structuralSeq = 0;
  let started = false;
  let lastBase: GeminiEventBase | undefined;

  const open = (timestamp: string, model?: string): void => {
    if (started) return;
    started = true;
    const seed = startTime ?? timestamp;
    events.push(geminiSessionStart({ sessionId, timestamp: seed, model }));
  };

  for (const message of messages) {
    const base: GeminiEventBase = {
      sessionId,
      timestamp: message.timestamp,
      model: message.model,
    };
    open(message.timestamp, message.model);
    lastBase = base;

    if (message.type === "gemini") {
      if (typeof message.content === "string" && message.content.length > 0) {
        const seq = structuralSeq;
        structuralSeq += 1;
        events.push(geminiAgentMessage(base, seq));
      }
    } else if (message.type === "user") {
      const textPartCount = userTextParts(message.content).length;
      for (let i = 0; i < textPartCount; i += 1) {
        const seq = structuralSeq;
        structuralSeq += 1;
        events.push(geminiUserPrompt(base, seq));
      }
      for (const part of functionResponseParts(message.content)) {
        const span = {
          toolName: part.toolName,
          toolCallId: part.toolCallId,
        };
        events.push(geminiToolPre(base, span));
        events.push(geminiToolPost(base, span));
      }
    }
  }

  if (options.complete && lastBase !== undefined) {
    events.push(geminiSessionEnd(lastBase));
  }

  return events;
}

function hashHex(event: RegimenEvent): string {
  return eventHash(event).toString("hex");
}

/**
 * The head+tail byte budget for tool output. Tool results run to tens of
 * kilobytes; the judge needs the shape of a result, not every byte. Mirrors the
 * Claude/Codex/Copilot readers' budget so all harnesses present output identically.
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
 * The content projection: the conversation text the judge reads, anchored to
 * the structural events `geminiEvents` derives and never stored in the DB. A
 * sibling pass over the same folded messages and the same recognition, so the
 * seq order and the anchor rules cannot drift from the event fold. A `gemini`
 * message contributes its answer string (never `thoughts`); a `user` message
 * contributes its text parts and the output of each functionResponse part.
 */
function geminiContent(
  messages: GeminiMessage[],
  sessionId: string,
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let lineSeq = 0;
  let structuralSeq = 0;

  for (const message of messages) {
    const base: GeminiEventBase = {
      sessionId,
      timestamp: message.timestamp,
      model: message.model,
    };

    if (message.type === "gemini") {
      if (typeof message.content === "string" && message.content.length > 0) {
        const seq = structuralSeq;
        structuralSeq += 1;
        chunks.push({
          kind: "assistant_answer",
          text: message.content,
          anchor: { eventHash: hashHex(geminiAgentMessage(base, seq)) },
          lineSeq,
        });
        lineSeq += 1;
      }
    } else if (message.type === "user") {
      for (const text of userTextParts(message.content)) {
        const seq = structuralSeq;
        structuralSeq += 1;
        chunks.push({
          kind: "human_prompt",
          text,
          anchor: { eventHash: hashHex(geminiUserPrompt(base, seq)) },
          lineSeq,
        });
        lineSeq += 1;
      }
      for (const part of functionResponseParts(message.content)) {
        chunks.push({
          kind: "tool_output",
          text: truncateHeadTail(part.output),
          anchor: { sessionId, toolCallId: part.toolCallId },
          lineSeq,
        });
        lineSeq += 1;
      }
    }
  }

  return chunks;
}

/**
 * The record shapes the reader projects, by folded message `type`. A `gemini`
 * or `user` message is handled; any other type (the rare `info` record, or an
 * unseen future type) is counted as an unknown type per ADR-0007 and skipped,
 * never failing the read.
 */
const KNOWN_MESSAGE_TYPES = new Set(["gemini", "user"]);

function geminiRecords(content: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const obj = asObject(parsed);
    if (obj !== undefined) records.push(obj);
  }
  return records;
}

export function geminiRead(
  content: string,
  options: RolloutReadOptions,
): RolloutReadResult {
  const records = geminiRecords(content);
  const sessionId = readSessionId(records);
  const { messages, startTime } = foldMessages(records);

  const unknownRecordTypes: Record<string, number> = {};
  for (const message of messages) {
    if (KNOWN_MESSAGE_TYPES.has(message.type)) continue;
    const key = `message/${message.type}`;
    unknownRecordTypes[key] = (unknownRecordTypes[key] ?? 0) + 1;
  }

  return {
    events: geminiEvents(messages, sessionId, startTime, options),
    content: geminiContent(messages, sessionId),
    unknownRecordTypes,
    quarantined: [],
  };
}
