import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { geminiRead } from "../src/loader/rollout/gemini-reader.ts";
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

const SESSION = "bbddfdf7-482c-4b2d-bbfb-c9ba0982f534";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const init = line({
  sessionId: SESSION,
  projectHash: "ph",
  startTime: "2026-06-19T06:08:26.036Z",
  lastUpdated: "2026-06-19T06:08:26.036Z",
  kind: "main",
});

const snapshot = line({
  $set: {
    messages: [
      {
        id: "d04923d38bb0f6017037e74183378ef4",
        timestamp: "2026-06-19T06:08:26.036Z",
        type: "user",
        content: [{ text: "<session_context>\nsetup\n</session_context>" }],
      },
    ],
    lastUpdated: "2026-06-19T06:08:26.036Z",
  },
});

const lastUpdatedOnly = line({
  $set: { lastUpdated: "2026-06-19T06:08:47.954Z" },
});

const userPrompt = line({
  id: "c9677e0c-c6b0-4fce-913a-ad01c9d0de44",
  timestamp: "2026-06-19T06:08:47.954Z",
  type: "user",
  content: [{ text: "please run the probe" }],
});

const geminiAnswer = line({
  id: "424b570c-8af7-4362-b336-cb3581b0507c",
  timestamp: "2026-06-19T06:08:55.715Z",
  type: "gemini",
  content: "I am going to execute the probe script.",
  thoughts: [
    {
      subject: "Analyzing",
      description: "SECRET-CHAIN-OF-THOUGHT",
      timestamp: "2026-06-19T06:08:53.490Z",
    },
  ],
  tokens: { input: 1, output: 1, total: 2 },
  model: "gemini-3.5-flash",
});

const toolResult = line({
  id: "08005abc-7d19-40cc-8e5f-6e7d6dd35067",
  timestamp: "2026-06-19T06:08:59.186Z",
  type: "user",
  content: [
    {
      functionResponse: {
        id: "run_shell_command__gwxxh8au",
        name: "run_shell_command",
        response: { output: "wrote /tmp/probe.out" },
      },
    },
  ],
});

test("a user message with a text part maps to a schema-valid v1 user_prompt stamped gemini at seq 0", () => {
  const { events } = geminiRead([init, snapshot, userPrompt].join("\n"), {
    complete: false,
  });
  const prompts = events.filter(
    (e) =>
      e.event_type === "user_prompt" &&
      e.timestamp === "2026-06-19T06:08:47.954Z",
  );
  expect(prompts.length).toBe(1);
  const prompt = prompts[0]!;
  validate(prompt);
  expect(validate.errors ?? []).toEqual([]);
  expect(prompt.harness).toBe("gemini");
  expect(prompt.session_id).toBe(SESSION);
  expect(prompt.span_phase).toBe("point");
  expect(prompt.span_name).toBe("user_prompt");
});

test("the snapshot context message is folded as a user_prompt distinct from the appended prompt", () => {
  const { events } = geminiRead([init, snapshot, userPrompt].join("\n"), {
    complete: false,
  });
  const prompts = events.filter((e) => e.event_type === "user_prompt");
  // The 32-hex snapshot message and the UUID append message are distinct ids,
  // so the id-deduped fold keeps both as user prompts.
  expect(prompts.length).toBe(2);
  expect(prompts[0]!.timestamp).toBe("2026-06-19T06:08:26.036Z");
  expect(prompts[1]!.timestamp).toBe("2026-06-19T06:08:47.954Z");
});

test("a gemini message with string content mints an agent.message carrying the model", () => {
  const { events } = geminiRead(
    [init, snapshot, userPrompt, geminiAnswer].join("\n"),
    { complete: false },
  );
  const messages = events.filter((e) => e.event_type === "agent.message");
  expect(messages.length).toBe(1);
  const message = messages[0]!;
  validate(message);
  expect(validate.errors ?? []).toEqual([]);
  expect(message.harness).toBe("gemini");
  expect(message.model).toBe("gemini-3.5-flash");
  expect(message.span_name).toBe("agent_message");
});

test("a gemini message with empty content mints no agent.message and consumes no seq", () => {
  const emptyGemini = line({
    id: "empty-1",
    timestamp: "2026-06-19T06:09:24.727Z",
    type: "gemini",
    content: "",
    thoughts: [],
    model: "gemini-3.5-flash",
  });
  const { events } = geminiRead(
    [init, snapshot, userPrompt, emptyGemini, geminiAnswer].join("\n"),
    { complete: false },
  );
  const messages = events.filter((e) => e.event_type === "agent.message");
  expect(messages.length).toBe(1);
});

test("a $set with only lastUpdated changes nothing in the fold", () => {
  const withPatch = geminiRead(
    [init, snapshot, lastUpdatedOnly, userPrompt].join("\n"),
    { complete: false },
  );
  const withoutPatch = geminiRead([init, snapshot, userPrompt].join("\n"), {
    complete: false,
  });
  expect(withPatch.events.length).toBe(withoutPatch.events.length);
});

test("an info-type record is skipped and counted in unknownRecordTypes, not failed", () => {
  const info = line({
    id: "info-1",
    timestamp: "2026-06-19T06:09:24.728Z",
    type: "info",
    content: "a slash command was used",
  });
  const { events, unknownRecordTypes } = geminiRead(
    [init, snapshot, userPrompt, info].join("\n"),
    { complete: false },
  );
  // info contributes no event.
  expect(events.some((e) => e.timestamp === "2026-06-19T06:09:24.728Z")).toBe(
    false,
  );
  expect(unknownRecordTypes["message/info"]).toBe(1);
});

test("a functionResponse part maps to one tool.pre and one tool.post keyed by its id+name", () => {
  const { events } = geminiRead(
    [init, snapshot, userPrompt, toolResult].join("\n"),
    { complete: false },
  );
  const pres = events.filter(
    (e) =>
      e.event_type === "tool.pre" &&
      e.attributes.tool_call_id === "run_shell_command__gwxxh8au",
  );
  const posts = events.filter(
    (e) =>
      e.event_type === "tool.post" &&
      e.attributes.tool_call_id === "run_shell_command__gwxxh8au",
  );
  expect(pres.length).toBe(1);
  expect(posts.length).toBe(1);
  expect(pres[0]!.attributes.tool_name).toBe("run_shell_command");
  expect(pres[0]!.span_name).toBe("tool:run_shell_command");
});

test("a user message batching two functionResponse parts yields a span for each", () => {
  const parallel = line({
    id: "parallel-1",
    timestamp: "2026-06-19T06:09:34.517Z",
    type: "user",
    content: [
      {
        functionResponse: {
          id: "read_file__a",
          name: "read_file",
          response: { output: "one" },
        },
      },
      {
        functionResponse: {
          id: "run_shell_command__b",
          name: "run_shell_command",
          response: { output: "two" },
        },
      },
    ],
  });
  const { events } = geminiRead(
    [init, snapshot, userPrompt, parallel].join("\n"),
    { complete: false },
  );
  const callIds = new Set(
    events
      .filter((e) => e.event_type === "tool.pre")
      .map((e) => e.attributes.tool_call_id),
  );
  expect(callIds.has("read_file__a")).toBe(true);
  expect(callIds.has("run_shell_command__b")).toBe(true);
});

test("a session.start opens at the first folded message and complete:true closes at the last", () => {
  const { events } = geminiRead(
    [init, snapshot, userPrompt, geminiAnswer, toolResult].join("\n"),
    { complete: true },
  );
  const starts = events.filter((e) => e.event_type === "session.start");
  const ends = events.filter((e) => e.event_type === "session.end");
  expect(starts.length).toBe(1);
  expect(ends.length).toBe(1);
  validate(ends[0]!);
  expect(validate.errors ?? []).toEqual([]);
  expect(ends[0]!.attributes.end_reason_normalized).toBe("other");
  expect(events[0]).toBe(starts[0]);
  expect(events[events.length - 1]).toBe(ends[0]);
});

test("complete:false never appends a session.end", () => {
  const { events } = geminiRead(
    [init, snapshot, userPrompt, geminiAnswer].join("\n"),
    { complete: false },
  );
  expect(events.some((e) => e.event_type === "session.end")).toBe(false);
});

test("two consecutive gemini messages sharing a timestamp get distinct seq and both survive", () => {
  const ts = "2026-06-19T06:09:24.727Z";
  const first = line({
    id: "g1",
    timestamp: ts,
    type: "gemini",
    content: "first answer",
    thoughts: [],
    model: "gemini-3.5-flash",
  });
  const second = line({
    id: "g2",
    timestamp: ts,
    type: "gemini",
    content: "second answer",
    thoughts: [],
    model: "gemini-3.5-flash",
  });
  const { events } = geminiRead(
    [init, snapshot, userPrompt, first, second].join("\n"),
    { complete: false },
  );
  const messages = events.filter(
    (e) => e.event_type === "agent.message" && e.timestamp === ts,
  );
  expect(messages.length).toBe(2);
  expect(messages[0]!.attributes.seq).not.toBe(messages[1]!.attributes.seq);
});

test("the content projection yields a human_prompt and an assistant_answer chunk with the conversation text", () => {
  const { content } = geminiRead(
    [init, snapshot, userPrompt, geminiAnswer].join("\n"),
    { complete: false },
  );
  const human = content.find(
    (c) => c.kind === "human_prompt" && c.text === "please run the probe",
  );
  const answer = content.find((c) => c.kind === "assistant_answer");
  expect(human).toBeDefined();
  expect(answer?.text).toBe("I am going to execute the probe script.");
});

test("a functionResponse projects a tool_output chunk and never a tool_args chunk", () => {
  const { content } = geminiRead(
    [init, snapshot, userPrompt, toolResult].join("\n"),
    { complete: false },
  );
  const output = content.find((c) => c.kind === "tool_output");
  expect(output?.text).toBe("wrote /tmp/probe.out");
  expect(output?.anchor).toEqual({
    sessionId: SESSION,
    toolCallId: "run_shell_command__gwxxh8au",
  });
  expect(content.some((c) => c.kind === "tool_args")).toBe(false);
});

test("the thoughts array is never projected to any content chunk", () => {
  const { content } = geminiRead(
    [init, snapshot, userPrompt, geminiAnswer].join("\n"),
    { complete: false },
  );
  for (const c of content) {
    expect(c.text.includes("SECRET-CHAIN-OF-THOUGHT")).toBe(false);
  }
});

const SAMPLES = join(import.meta.dir, "..", "samples");

function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

function withStore(fn: (store: ReturnType<typeof openStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-gemini-anchor-"));
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

test("over the real Gemini transcript fixture, every content anchor resolves after inserting the events", () => {
  withStore((store) => {
    const { events, content } = geminiRead(
      fixture("transcript-gemini-recent.jsonl"),
      { complete: true },
    );
    for (const event of events) store.insertEvent(event);

    const tools = content.filter((c) => c.kind === "tool_output");
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

test("the real fixture's reasoning thoughts never reach the content projection", () => {
  const { content } = geminiRead(fixture("transcript-gemini-recent.jsonl"), {
    complete: true,
  });
  for (const c of content) {
    expect(c.text.includes("REDACTED-CHAIN-OF-THOUGHT")).toBe(false);
  }
});

test("over the real fixture, exactly one tool.pre and one tool.post are minted per functionResponse id", () => {
  const { events } = geminiRead(fixture("transcript-gemini-recent.jsonl"), {
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
