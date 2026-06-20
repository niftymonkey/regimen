import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { claudeRead } from "../src/loader/rollout/claude-reader.ts";
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

const SESSION = "08551ace-1f3c-40b2-a088-ef00ce37027f";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const userPrompt = line({
  type: "user",
  cwd: "/home/eng/project",
  isSidechain: false,
  message: { role: "user", content: "run the tests" },
  sessionId: SESSION,
  timestamp: "2026-06-19T21:36:05.040Z",
  uuid: "u-1",
});

test("a string-content user record maps to a schema-valid v1 user_prompt stamped claude", () => {
  const { events } = claudeRead(userPrompt, { complete: false });
  const prompts = events.filter((e) => e.event_type === "user_prompt");
  expect(prompts.length).toBe(1);
  const prompt = prompts[0]!;
  validate(prompt);
  expect(validate.errors ?? []).toEqual([]);
  expect(prompt.harness).toBe("claude");
  expect(prompt.session_id).toBe(SESSION);
  expect(prompt.span_phase).toBe("point");
  expect(prompt.span_name).toBe("user_prompt");
  expect(prompt.timestamp).toBe("2026-06-19T21:36:05.040Z");
  // The first anchored turn is seq 0; the seq is hashed so the content fold's
  // human_prompt anchor reproduces this event's hash exactly.
  expect(prompt.attributes.seq).toBe("0");
});

const assistantText = line({
  type: "assistant",
  cwd: "/home/eng/project",
  isSidechain: false,
  message: {
    id: "msg_02",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "I'll run the test suite now." }],
  },
  sessionId: SESSION,
  timestamp: "2026-06-19T21:36:06.812Z",
  uuid: "u-2",
});

test("an assistant text record mints an agent.message carrying the model and the next per-session seq", () => {
  const { events } = claudeRead([userPrompt, assistantText].join("\n"), {
    complete: false,
  });
  const messages = events.filter((e) => e.event_type === "agent.message");
  expect(messages.length).toBe(1);
  const message = messages[0]!;
  validate(message);
  expect(validate.errors ?? []).toEqual([]);
  expect(message.harness).toBe("claude");
  expect(message.session_id).toBe(SESSION);
  expect(message.span_phase).toBe("point");
  expect(message.span_name).toBe("agent_message");
  expect(message.model).toBe("claude-opus-4-8");
  // The user prompt took seq 0, so this assistant message is seq 1.
  expect(message.attributes.seq).toBe("1");
});

const assistantThinking = line({
  type: "assistant",
  cwd: "/home/eng/project",
  isSidechain: false,
  message: {
    id: "msg_01",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [
      { type: "thinking", thinking: "secret reasoning", signature: "s" },
    ],
  },
  sessionId: SESSION,
  timestamp: "2026-06-19T21:36:06.000Z",
  uuid: "u-think",
});

test("an assistant thinking record is excluded as chain-of-thought, minting no event and consuming no seq", () => {
  const { events } = claudeRead(
    [userPrompt, assistantThinking, assistantText].join("\n"),
    { complete: false },
  );
  expect(events.some((e) => e.event_type === "agent.message")).toBe(true);
  // No event is minted from the thinking record, and it consumes no seq: the
  // text answer still lands at seq 1 right after the seq-0 user prompt.
  const message = events.find((e) => e.event_type === "agent.message")!;
  expect(message.attributes.seq).toBe("1");
});

const toolUseBash = line({
  type: "assistant",
  cwd: "/home/eng/project",
  isSidechain: false,
  message: {
    id: "msg_03",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [
      {
        type: "tool_use",
        id: "toolu_bash01",
        name: "Bash",
        input: { command: "bun test", description: "Run the test suite" },
      },
    ],
  },
  sessionId: SESSION,
  timestamp: "2026-06-19T21:36:07.000Z",
  uuid: "u-tool",
});

test("an assistant tool_use record maps to a tool.pre carrying the tool name and the toolu call id", () => {
  const { events } = claudeRead(toolUseBash, { complete: false });
  const pre = events.find((e) => e.event_type === "tool.pre");
  expect(pre).toBeDefined();
  validate(pre!);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre!.span_phase).toBe("start");
  expect(pre!.span_name).toBe("tool:Bash");
  expect(pre!.attributes.tool_name).toBe("Bash");
  expect(pre!.attributes.tool_call_id).toBe("toolu_bash01");
});

const toolResultString = line({
  type: "user",
  cwd: "/home/eng/project",
  isSidechain: false,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_bash01", content: "42 pass" },
    ],
  },
  sessionId: SESSION,
  timestamp: "2026-06-19T21:36:08.500Z",
  uuid: "u-result",
});

test("a user tool_result record maps to a tool.post keyed by the tool_use_id, named from its tool_use, and mints no user_prompt", () => {
  const { events } = claudeRead([toolUseBash, toolResultString].join("\n"), {
    complete: false,
  });
  const post = events.find((e) => e.event_type === "tool.post");
  expect(post).toBeDefined();
  validate(post!);
  expect(validate.errors ?? []).toEqual([]);
  expect(post!.span_phase).toBe("end");
  expect(post!.span_name).toBe("tool:Bash");
  expect(post!.attributes.tool_name).toBe("Bash");
  expect(post!.attributes.tool_call_id).toBe("toolu_bash01");
  // A tool_result is a tool turn, not a human turn: no user_prompt is minted.
  expect(events.some((e) => e.event_type === "user_prompt")).toBe(false);
});

test("a session.start is synthesized at the first record's timestamp, as Claude writes no session-meta line", () => {
  const { events } = claudeRead([userPrompt, assistantText].join("\n"), {
    complete: false,
  });
  const starts = events.filter((e) => e.event_type === "session.start");
  expect(starts.length).toBe(1);
  const start = starts[0]!;
  validate(start);
  expect(validate.errors ?? []).toEqual([]);
  expect(start.harness).toBe("claude");
  expect(start.session_id).toBe(SESSION);
  expect(start.span_phase).toBe("start");
  expect(start.span_name).toBe("session");
  expect(start.timestamp).toBe("2026-06-19T21:36:05.040Z");
  expect(events[0]).toBe(start);
});

test("complete:true appends a single session.end at the last record's timestamp with the catch-all reason", () => {
  const { events } = claudeRead(
    [userPrompt, assistantText, toolUseBash, toolResultString].join("\n"),
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
  expect(end.timestamp).toBe("2026-06-19T21:36:08.500Z");
  expect(end.attributes.end_reason_normalized).toBe("other");
  expect(end.attributes.end_reason_native).toBeUndefined();
  expect(events[events.length - 1]).toBe(end);
});

test("complete:false never appends a session.end, so an open conversation stays open", () => {
  const { events } = claudeRead([userPrompt, assistantText].join("\n"), {
    complete: false,
  });
  expect(events.some((e) => e.event_type === "session.end")).toBe(false);
});

test("the content projection yields a human_prompt and an assistant_answer chunk with the conversation text", () => {
  const { content } = claudeRead([userPrompt, assistantText].join("\n"), {
    complete: false,
  });
  const human = content.find((c) => c.kind === "human_prompt");
  const answer = content.find((c) => c.kind === "assistant_answer");
  expect(human?.text).toBe("run the tests");
  expect(answer?.text).toBe("I'll run the test suite now.");
});

test("a thinking record contributes no content chunk, so chain-of-thought never reaches the judge", () => {
  const { content } = claudeRead(
    [userPrompt, assistantThinking, assistantText].join("\n"),
    { complete: false },
  );
  expect(content.some((c) => c.text.includes("secret reasoning"))).toBe(false);
  expect(content.filter((c) => c.kind === "assistant_answer").length).toBe(1);
});

test("tool args and tool output become tool_args and tool_output chunks anchored by the tool call id", () => {
  const { content } = claudeRead([toolUseBash, toolResultString].join("\n"), {
    complete: false,
  });
  const args = content.find((c) => c.kind === "tool_args");
  const output = content.find((c) => c.kind === "tool_output");
  expect(args?.text).toBe("bun test");
  expect(output?.text).toBe("42 pass");
  expect(args?.anchor).toEqual({
    sessionId: SESSION,
    toolCallId: "toolu_bash01",
  });
  expect(output?.anchor).toEqual({
    sessionId: SESSION,
    toolCallId: "toolu_bash01",
  });
});

const SAMPLES = join(import.meta.dir, "..", "samples");

function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

function withStore(fn: (store: ReturnType<typeof openStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-claude-anchor-"));
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

test("over the real Claude transcript fixture, every content anchor resolves after inserting the events", () => {
  withStore((store) => {
    const { events, content } = claudeRead(
      fixture("transcript-claude-recent.jsonl"),
      { complete: true },
    );
    for (const event of events) store.insertEvent(event);

    const human = content.filter((c) => c.kind === "human_prompt");
    const answers = content.filter((c) => c.kind === "assistant_answer");
    const tools = content.filter(
      (c) => c.kind === "tool_args" || c.kind === "tool_output",
    );
    // The fixture has one engineer prompt, two assistant answers, and tool turns.
    expect(human.length).toBe(1);
    expect(answers.length).toBe(2);
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

test("the real fixture's thinking blocks never reach the content projection", () => {
  const { content } = claudeRead(fixture("transcript-claude-recent.jsonl"), {
    complete: true,
  });
  for (const c of content) {
    expect(c.text.includes("Let me start by reading the config")).toBe(false);
  }
});
