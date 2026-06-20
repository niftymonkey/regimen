/**
 * The Claude Code transcript reader.
 *
 * The judge-time transcript source for the Claude harness, the sibling of the
 * Codex rollout reader: a pure fold from one Claude Code transcript file's
 * JSONL content to the same harness-neutral RolloutReadResult (the v1 event
 * vocabulary plus the content projection), so everything downstream (the store,
 * the signal projections, the evidence read side) is reused unchanged.
 */
import type { RegimenEvent } from "../../../hooks/event-log.ts";
import { eventHash } from "../../hash.ts";
import type {
  ContentChunk,
  RolloutReadOptions,
  RolloutReadResult,
} from "../reader-types.ts";
import {
  claudeAgentMessage,
  claudeSessionEnd,
  claudeSessionStart,
  claudeToolPost,
  claudeToolPre,
  claudeUserPrompt,
  type ClaudeEventBase,
} from "../translators/claude-events.ts";

/**
 * The record types the reader projects to events or content. Claude writes many
 * record types (mode, last-prompt, ai-title, system, etc.); only `user` and
 * `assistant` carry conversation. The session is opened at the first such record
 * and closed at the last, since Claude writes no session-meta or session-end
 * record the way Codex does.
 */
function isConversationLine(type: string): boolean {
  return type === "user" || type === "assistant";
}

/**
 * The first content block of a message record, or undefined. Claude Code writes
 * one content block per JSONL message record (verified across real transcripts:
 * an assistant record is a single thinking, text, or tool_use block), so the
 * reader keys on the first block's type to classify the record.
 */
function firstBlock(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>)
    : undefined;
}

interface ClaudeLine {
  readonly type: string;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly cwd?: string;
  readonly message: Record<string, unknown> | undefined;
}

function parseLine(raw: string): ClaudeLine | undefined {
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
  const message =
    typeof obj.message === "object" && obj.message !== null
      ? (obj.message as Record<string, unknown>)
      : undefined;
  return {
    type: obj.type,
    timestamp: obj.timestamp,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "unknown",
    cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
    message,
  };
}

function claudeEvents(
  content: string,
  options: RolloutReadOptions,
): RegimenEvent[] {
  const events: RegimenEvent[] = [];
  let structuralSeq = 0;
  const toolNameByCallId = new Map<string, string>();
  let started = false;
  let lastBase: ClaudeEventBase | undefined;

  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const line = parseLine(raw);
    if (line === undefined) continue;
    if (!isConversationLine(line.type) || line.message === undefined) continue;

    const model =
      typeof line.message.model === "string" ? line.message.model : undefined;
    const base: ClaudeEventBase = {
      sessionId: line.sessionId,
      timestamp: line.timestamp,
      model,
      cwd: line.cwd,
    };
    if (!started) {
      started = true;
      events.push(claudeSessionStart(base));
    }
    lastBase = base;

    if (line.type === "user") {
      const messageContent = line.message.content;
      if (typeof messageContent === "string") {
        const seq = structuralSeq;
        structuralSeq += 1;
        events.push(claudeUserPrompt(base, seq));
      } else if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (
            typeof block !== "object" ||
            block === null ||
            (block as Record<string, unknown>).type !== "tool_result"
          ) {
            continue;
          }
          const callId = (block as Record<string, unknown>).tool_use_id;
          if (typeof callId !== "string") continue;
          const toolName = toolNameByCallId.get(callId) ?? "unknown";
          events.push(claudeToolPost(base, { toolName, toolCallId: callId }));
        }
      }
    } else {
      const block = firstBlock(line.message);
      if (block === undefined) continue;
      if (block.type === "text") {
        const seq = structuralSeq;
        structuralSeq += 1;
        events.push(claudeAgentMessage(base, seq));
      } else if (block.type === "tool_use") {
        const callId = typeof block.id === "string" ? block.id : undefined;
        const toolName =
          typeof block.name === "string" ? block.name : "unknown";
        if (callId !== undefined) {
          toolNameByCallId.set(callId, toolName);
          events.push(claudeToolPre(base, { toolName, toolCallId: callId }));
        }
      }
    }
  }

  if (options.complete && lastBase !== undefined) {
    events.push(claudeSessionEnd(lastBase));
  }

  return events;
}

function hashHex(event: RegimenEvent): string {
  return eventHash(event).toString("hex");
}

/** The text of an assistant text-block message. */
function textBlockText(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

/**
 * The judge-relevant text of a tool call's input, extracted per tool so the
 * judge sees the command or the change, not the control envelope. Returns
 * undefined when the call carries no judge-relevant text, so the caller emits no
 * chunk rather than fabricating one. Mirrors the Codex reader's toolArgsText.
 *   - `Bash` -> the command string.
 *   - `Edit` / `Write` / `MultiEdit` / `NotebookEdit` -> the touched file path.
 *   - `Task` / `Agent` -> the subagent prompt.
 *   - `Skill` -> the skill arguments, when present.
 */
function toolArgsText(toolName: string, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const args = input as Record<string, unknown>;
  if (toolName === "Bash") {
    return typeof args.command === "string" && args.command.length > 0
      ? args.command
      : undefined;
  }
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  ) {
    return typeof args.file_path === "string" && args.file_path.length > 0
      ? args.file_path
      : undefined;
  }
  if (toolName === "Task" || toolName === "Agent") {
    return typeof args.prompt === "string" && args.prompt.length > 0
      ? args.prompt
      : undefined;
  }
  if (toolName === "Skill") {
    return typeof args.args === "string" && args.args.length > 0
      ? args.args
      : undefined;
  }
  return undefined;
}

/**
 * The text of a `tool_result` block's content: a plain string, or the joined
 * text of its `text` content blocks when Claude writes the array form (an array
 * carries text and non-text blocks like `tool_reference`; only text projects).
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      texts.push((block as Record<string, unknown>).text as string);
    }
  }
  return texts.join("");
}

/**
 * The head+tail byte budget for tool output. Tool results run to tens of
 * kilobytes; the judge needs the shape of a result, not every byte. Mirrors the
 * Codex reader's budget so both harnesses present tool output identically.
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
 * structural events `claudeEvents` derives and never stored in the DB. A sibling
 * pass over the same parsed lines and the same record recognition, so the anchor
 * rules cannot drift from the event fold (the seq order is identical).
 */
function claudeContent(content: string): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let lineSeq = 0;
  let structuralSeq = 0;

  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const line = parseLine(raw);
    if (line === undefined) continue;
    if (!isConversationLine(line.type) || line.message === undefined) continue;

    const model =
      typeof line.message.model === "string" ? line.message.model : undefined;
    const base: ClaudeEventBase = {
      sessionId: line.sessionId,
      timestamp: line.timestamp,
      model,
      cwd: line.cwd,
    };

    if (line.type === "user") {
      const messageContent = line.message.content;
      if (typeof messageContent === "string") {
        const seq = structuralSeq;
        structuralSeq += 1;
        chunks.push({
          kind: "human_prompt",
          text: messageContent,
          anchor: { eventHash: hashHex(claudeUserPrompt(base, seq)) },
          lineSeq,
        });
        lineSeq += 1;
      } else if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (
            typeof block !== "object" ||
            block === null ||
            (block as Record<string, unknown>).type !== "tool_result"
          ) {
            continue;
          }
          const record = block as Record<string, unknown>;
          const callId = record.tool_use_id;
          if (typeof callId !== "string") continue;
          const text = truncateHeadTail(toolResultText(record.content));
          chunks.push({
            kind: "tool_output",
            text,
            anchor: { sessionId: line.sessionId, toolCallId: callId },
            lineSeq,
          });
          lineSeq += 1;
        }
      }
    } else {
      const block = firstBlock(line.message);
      if (block === undefined) continue;
      if (block.type === "text") {
        const seq = structuralSeq;
        structuralSeq += 1;
        chunks.push({
          kind: "assistant_answer",
          text: textBlockText(block),
          anchor: { eventHash: hashHex(claudeAgentMessage(base, seq)) },
          lineSeq,
        });
        lineSeq += 1;
      } else if (block.type === "tool_use") {
        const callId = typeof block.id === "string" ? block.id : undefined;
        const toolName =
          typeof block.name === "string" ? block.name : "unknown";
        if (callId !== undefined) {
          const text = toolArgsText(toolName, block.input);
          if (text !== undefined) {
            chunks.push({
              kind: "tool_args",
              text,
              anchor: { sessionId: line.sessionId, toolCallId: callId },
              lineSeq,
            });
            lineSeq += 1;
          }
        }
      }
    }
  }

  return chunks;
}

export function claudeRead(
  content: string,
  options: RolloutReadOptions,
): RolloutReadResult {
  return {
    events: claudeEvents(content, options),
    content: claudeContent(content),
    unknownRecordTypes: {},
    quarantined: [],
  };
}
