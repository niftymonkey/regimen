import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { copilotRead } from "../src/loader/rollout/copilot-reader.ts";
import type { AnchorRef } from "../src/loader/reader-types.ts";
import { openStore } from "../src/store.ts";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const SESSION = "e2ba254f-5455-47e2-aa80-1bc2706d7294";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const sessionStart = line({
  type: "session.start",
  data: {
    sessionId: SESSION,
    copilotVersion: "1.0.63",
    context: { cwd: "/home/eng/project" },
  },
  id: "evt-start",
  timestamp: "2026-06-18T04:33:05.080Z",
  parentId: null,
});

const userMessage = line({
  type: "user.message",
  data: {
    content: "does this work?",
    transformedContent:
      "<current_datetime>x</current_datetime>\n\ndoes this work?",
  },
  id: "evt-user",
  timestamp: "2026-06-18T04:33:18.511Z",
  parentId: "evt-start",
});

test("a user.message maps to a schema-valid v1 user_prompt stamped copilot at seq 0", () => {
  const { events } = copilotRead([sessionStart, userMessage].join("\n"), {
    complete: false,
  });
  const prompts = events.filter((e) => e.event_type === "user_prompt");
  expect(prompts.length).toBe(1);
  const prompt = prompts[0]!;
  validate(prompt);
  expect(validate.errors ?? []).toEqual([]);
  expect(prompt.harness).toBe("copilot");
  expect(prompt.session_id).toBe(SESSION);
  expect(prompt.span_phase).toBe("point");
  expect(prompt.span_name).toBe("user_prompt");
  expect(prompt.timestamp).toBe("2026-06-18T04:33:18.511Z");
  expect(prompt.attributes.seq).toBe("0");
});

const assistantAnswer = line({
  type: "assistant.message",
  data: {
    content: "Yes, gh is logged in.",
    model: "gpt-5-mini",
    reasoningOpaque: "SECRET-CHAIN-OF-THOUGHT",
    encryptedContent: "SECRET-ENCRYPTED-ANSWER",
    toolRequests: [],
  },
  id: "evt-answer",
  timestamp: "2026-06-18T04:33:51.180Z",
  parentId: "evt-user",
});

test("a non-empty assistant.message mints an agent.message carrying the model and the next per-session seq", () => {
  const { events } = copilotRead(
    [sessionStart, userMessage, assistantAnswer].join("\n"),
    { complete: false },
  );
  const messages = events.filter((e) => e.event_type === "agent.message");
  expect(messages.length).toBe(1);
  const message = messages[0]!;
  validate(message);
  expect(validate.errors ?? []).toEqual([]);
  expect(message.harness).toBe("copilot");
  expect(message.session_id).toBe(SESSION);
  expect(message.span_phase).toBe("point");
  expect(message.span_name).toBe("agent_message");
  expect(message.model).toBe("gpt-5-mini");
  expect(message.attributes.seq).toBe("1");
});

const assistantToolOnly = line({
  type: "assistant.message",
  data: {
    content: "",
    model: "gpt-5-mini",
    reasoningOpaque: "TOOL-ONLY-CHAIN-OF-THOUGHT",
    encryptedContent: "TOOL-ONLY-ENCRYPTED-ANSWER",
    toolRequests: [
      {
        toolCallId: "call_x",
        name: "bash",
        arguments: { command: "ls" },
        type: "function",
      },
    ],
  },
  id: "evt-toolonly",
  timestamp: "2026-06-18T04:33:52.000Z",
  parentId: "evt-answer",
});

test("an assistant.message with empty content mints no agent.message and consumes no seq", () => {
  const { events } = copilotRead(
    [sessionStart, userMessage, assistantToolOnly, assistantAnswer].join("\n"),
    { complete: false },
  );
  const messages = events.filter((e) => e.event_type === "agent.message");
  expect(messages.length).toBe(1);
  // The user prompt took seq 0; the empty-content message consumed no seq, so
  // the later non-empty answer still lands at seq 1.
  expect(messages[0]!.attributes.seq).toBe("1");
});

const TOOL_CALL = "call_bash01";

const assistantWithTool = line({
  type: "assistant.message",
  data: {
    content: "Running a check.",
    model: "gpt-5-mini",
    toolRequests: [
      {
        toolCallId: TOOL_CALL,
        name: "bash",
        arguments: { command: "gh auth status" },
        type: "function",
      },
    ],
  },
  id: "evt-assistant-tool",
  timestamp: "2026-06-18T04:33:51.180Z",
  parentId: "evt-user",
});

const toolStart = line({
  type: "tool.execution_start",
  data: {
    toolCallId: TOOL_CALL,
    toolName: "bash",
    arguments: { command: "gh auth status", description: "check" },
  },
  id: "evt-tool-start",
  timestamp: "2026-06-18T04:33:51.181Z",
  parentId: "evt-assistant-tool",
});

const toolComplete = line({
  type: "tool.execution_complete",
  data: {
    toolCallId: TOOL_CALL,
    result: { content: "Logged in as niftymonkey" },
    success: true,
  },
  id: "evt-tool-complete",
  timestamp: "2026-06-18T04:33:52.000Z",
  parentId: "evt-tool-start",
});

test("a tool.execution_start maps to a tool.pre carrying the tool name and call id", () => {
  const { events } = copilotRead(
    [sessionStart, userMessage, assistantWithTool, toolStart].join("\n"),
    { complete: false },
  );
  const pre = events.find((e) => e.event_type === "tool.pre");
  expect(pre).toBeDefined();
  validate(pre!);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre!.span_phase).toBe("start");
  expect(pre!.span_name).toBe("tool:bash");
  expect(pre!.attributes.tool_name).toBe("bash");
  expect(pre!.attributes.tool_call_id).toBe(TOOL_CALL);
});

test("a tool.execution_complete maps to a tool.post keyed by the same call id", () => {
  const { events } = copilotRead(
    [
      sessionStart,
      userMessage,
      assistantWithTool,
      toolStart,
      toolComplete,
    ].join("\n"),
    { complete: false },
  );
  const post = events.find((e) => e.event_type === "tool.post");
  expect(post).toBeDefined();
  validate(post!);
  expect(validate.errors ?? []).toEqual([]);
  expect(post!.span_phase).toBe("end");
  expect(post!.span_name).toBe("tool:bash");
  expect(post!.attributes.tool_name).toBe("bash");
  expect(post!.attributes.tool_call_id).toBe(TOOL_CALL);
});

test("exactly one tool.pre and one tool.post are minted per toolCallId, with no second pre from assistant.message.toolRequests", () => {
  const { events } = copilotRead(
    [
      sessionStart,
      userMessage,
      assistantWithTool,
      toolStart,
      toolComplete,
    ].join("\n"),
    { complete: false },
  );
  const pres = events.filter(
    (e) =>
      e.event_type === "tool.pre" && e.attributes.tool_call_id === TOOL_CALL,
  );
  const posts = events.filter(
    (e) =>
      e.event_type === "tool.post" && e.attributes.tool_call_id === TOOL_CALL,
  );
  expect(pres.length).toBe(1);
  expect(posts.length).toBe(1);
});

test("a session.start is synthesized at the first conversation line's timestamp", () => {
  const { events } = copilotRead(
    [sessionStart, userMessage, assistantAnswer].join("\n"),
    { complete: false },
  );
  const starts = events.filter((e) => e.event_type === "session.start");
  expect(starts.length).toBe(1);
  const start = starts[0]!;
  validate(start);
  expect(validate.errors ?? []).toEqual([]);
  expect(start.harness).toBe("copilot");
  expect(start.session_id).toBe(SESSION);
  expect(start.span_phase).toBe("start");
  expect(start.span_name).toBe("session");
  expect(start.timestamp).toBe("2026-06-18T04:33:18.511Z");
  expect(events[0]).toBe(start);
});

test("complete:true appends a single session.end at the last line's timestamp with the catch-all reason", () => {
  const { events } = copilotRead(
    [
      sessionStart,
      userMessage,
      assistantWithTool,
      toolStart,
      toolComplete,
    ].join("\n"),
    { complete: true },
  );
  const ends = events.filter((e) => e.event_type === "session.end");
  expect(ends.length).toBe(1);
  const end = ends[0]!;
  validate(end);
  expect(validate.errors ?? []).toEqual([]);
  expect(end.session_id).toBe(SESSION);
  expect(end.span_phase).toBe("end");
  expect(end.span_name).toBe("session");
  expect(end.timestamp).toBe("2026-06-18T04:33:52.000Z");
  expect(end.attributes.end_reason_normalized).toBe("other");
  expect(end.attributes.end_reason_native).toBeUndefined();
  expect(events[events.length - 1]).toBe(end);
});

test("complete:false never appends a session.end, so an open conversation stays open", () => {
  const { events } = copilotRead(
    [sessionStart, userMessage, assistantAnswer].join("\n"),
    { complete: false },
  );
  expect(events.some((e) => e.event_type === "session.end")).toBe(false);
});

test("the content projection yields a human_prompt and an assistant_answer chunk with the conversation text", () => {
  const { content } = copilotRead(
    [sessionStart, userMessage, assistantAnswer].join("\n"),
    { complete: false },
  );
  const human = content.find((c) => c.kind === "human_prompt");
  const answer = content.find((c) => c.kind === "assistant_answer");
  expect(human?.text).toBe("does this work?");
  expect(answer?.text).toBe("Yes, gh is logged in.");
});

test("an empty-content assistant.message contributes no assistant_answer chunk", () => {
  const { content } = copilotRead(
    [sessionStart, userMessage, assistantToolOnly].join("\n"),
    { complete: false },
  );
  expect(content.some((c) => c.kind === "assistant_answer")).toBe(false);
});

test("the encrypted reasoningOpaque and encryptedContent are never projected to any chunk", () => {
  const { content } = copilotRead(
    [sessionStart, userMessage, assistantAnswer, assistantToolOnly].join("\n"),
    { complete: false },
  );
  for (const c of content) {
    expect(c.text.includes("SECRET-CHAIN-OF-THOUGHT")).toBe(false);
    expect(c.text.includes("SECRET-ENCRYPTED-ANSWER")).toBe(false);
    expect(c.text.includes("TOOL-ONLY-CHAIN-OF-THOUGHT")).toBe(false);
    expect(c.text.includes("TOOL-ONLY-ENCRYPTED-ANSWER")).toBe(false);
  }
});

test("tool args and tool output become tool_args and tool_output chunks anchored by the tool call id", () => {
  const { content } = copilotRead(
    [
      sessionStart,
      userMessage,
      assistantWithTool,
      toolStart,
      toolComplete,
    ].join("\n"),
    { complete: false },
  );
  const args = content.find((c) => c.kind === "tool_args");
  const output = content.find((c) => c.kind === "tool_output");
  expect(args?.text).toBe("gh auth status");
  expect(output?.text).toBe("Logged in as niftymonkey");
  expect(args?.anchor).toEqual({ sessionId: SESSION, toolCallId: TOOL_CALL });
  expect(output?.anchor).toEqual({ sessionId: SESSION, toolCallId: TOOL_CALL });
});

const SAMPLES = join(import.meta.dir, "..", "samples");

function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

function withStore(fn: (store: ReturnType<typeof openStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-copilot-anchor-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function isEventHashAnchor(
  anchor: AnchorRef,
): anchor is { readonly eventHash: string } {
  return "eventHash" in anchor;
}

function isToolAnchor(
  anchor: AnchorRef,
): anchor is { readonly sessionId: string; readonly toolCallId: string } {
  return "toolCallId" in anchor;
}

function eventHashResolves(
  store: ReturnType<typeof openStore>,
  eventHash: string,
): boolean {
  const row = store.db
    .prepare("SELECT 1 FROM events WHERE event_hash = ?")
    .get(Buffer.from(eventHash, "hex"));
  return row !== null;
}

function toolAnchorResolves(
  store: ReturnType<typeof openStore>,
  sessionId: string,
  toolCallId: string,
): boolean {
  const row = store.db
    .prepare(
      "SELECT 1 FROM tool_call_spans WHERE session_id = ? AND tool_call_id = ?",
    )
    .get(sessionId, toolCallId);
  return row !== null;
}

test("over the real Copilot transcript fixture, every content anchor resolves after inserting the events", () => {
  withStore((store) => {
    const { events, content } = copilotRead(
      fixture("transcript-copilot-recent.jsonl"),
      { complete: true },
    );
    for (const event of events) store.insertEvent(event);

    const human = content.filter((c) => c.kind === "human_prompt");
    const answers = content.filter((c) => c.kind === "assistant_answer");
    const tools = content.filter(
      (c) => c.kind === "tool_args" || c.kind === "tool_output",
    );
    // The fixture has two engineer prompts, three non-empty assistant answers
    // (the tool-only turn contributes none), and two tool turns.
    expect(human.length).toBe(2);
    expect(answers.length).toBe(3);
    expect(tools.length).toBeGreaterThan(0);

    for (const c of content) {
      if (isEventHashAnchor(c.anchor)) {
        expect(
          eventHashResolves(store, c.anchor.eventHash),
          `${c.kind} anchor ${c.anchor.eventHash} unresolved`,
        ).toBe(true);
      } else if (isToolAnchor(c.anchor)) {
        expect(
          toolAnchorResolves(store, c.anchor.sessionId, c.anchor.toolCallId),
        ).toBe(true);
      }
    }
  });
});

test("the real fixture's encrypted fields never reach the content projection", () => {
  const { content } = copilotRead(fixture("transcript-copilot-recent.jsonl"), {
    complete: true,
  });
  for (const c of content) {
    expect(c.text.includes("REDACTED-CHAIN-OF-THOUGHT")).toBe(false);
    expect(c.text.includes("REDACTED-ENCRYPTED-ANSWER")).toBe(false);
  }
});

test("over the real fixture, exactly one tool.pre and one tool.post are minted per toolCallId", () => {
  const { events } = copilotRead(fixture("transcript-copilot-recent.jsonl"), {
    complete: true,
  });
  const callIds = new Set(
    events
      .filter(
        (e) => e.event_type === "tool.pre" || e.event_type === "tool.post",
      )
      .map((e) => e.attributes.tool_call_id),
  );
  expect(callIds.size).toBeGreaterThan(0);
  for (const callId of callIds) {
    const pres = events.filter(
      (e) =>
        e.event_type === "tool.pre" && e.attributes.tool_call_id === callId,
    );
    const posts = events.filter(
      (e) =>
        e.event_type === "tool.post" && e.attributes.tool_call_id === callId,
    );
    expect(pres.length).toBe(1);
    expect(posts.length).toBe(1);
  }
});
