import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  applyPatchFilePaths,
  rolloutEvents,
} from "../src/loader/rollout/codex-reader.ts";
import { codexUserPrompt } from "../src/loader/translators/codex-events.ts";
import { eventHash } from "../src/hash.ts";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const SESSION = "019e0000-1111-7000-8000-000000000001";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const sessionMeta = line({
  timestamp: "2026-06-02T10:00:00.100Z",
  type: "session_meta",
  payload: { id: SESSION, cwd: "/work/sample-project", source: "cli" },
});

const userMessage = line({
  timestamp: "2026-06-02T10:00:00.400Z",
  type: "event_msg",
  payload: {
    type: "user_message",
    message: "run the tests",
    text_elements: [],
  },
});

/**
 * The canonical `response_item` user message: the stream the structural fold
 * mints `user_prompt` from (carrying the per-session seq), with the matching
 * `event_msg user_message` above as its dedup'd twin.
 */
const userPromptItem = line({
  timestamp: "2026-06-02T10:00:00.400Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "run the tests" }],
  },
});

test("session_meta maps to a schema-valid v1 session.start stamped codex", () => {
  const events = rolloutEvents(sessionMeta, { complete: false });
  const starts = events.filter((e) => e.event_type === "session.start");
  expect(starts.length).toBe(1);
  const start = starts[0]!;
  validate(start);
  expect(validate.errors ?? []).toEqual([]);
  expect(start.harness).toBe("codex");
  expect(start.session_id).toBe(SESSION);
  expect(start.span_phase).toBe("start");
  expect(start.span_name).toBe("session");
  expect(start.timestamp).toBe("2026-06-02T10:00:00.100Z");
});

test("session_meta's cwd is stamped on the session.start so the conversation is anchored to its directory", () => {
  const events = rolloutEvents(sessionMeta, { complete: false });
  const start = events.find((e) => e.event_type === "session.start")!;
  expect(start.cwd).toBe("/work/sample-project");
});

const functionCall = line({
  timestamp: "2026-06-02T10:00:02.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "exec_command",
    arguments: '{"cmd":"bun test"}',
    call_id: "call_shell01",
  },
});
const functionCallOutput = line({
  timestamp: "2026-06-02T10:00:02.600Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: "call_shell01",
    output: "<redacted>",
  },
});

const turnContext = line({
  timestamp: "2026-06-02T10:00:00.300Z",
  type: "turn_context",
  payload: { model: "gpt-5.5", cwd: "/work/sample-project", effort: "medium" },
});

test("turn_context model is stamped on events that follow it, leaving the earlier session.start unmodelled", () => {
  const events = rolloutEvents(
    [sessionMeta, turnContext, userPromptItem].join("\n"),
    { complete: false },
  );
  const start = events.find((e) => e.event_type === "session.start")!;
  const prompt = events.find((e) => e.event_type === "user_prompt")!;
  expect(start.model).toBeUndefined();
  expect(prompt.model).toBe("gpt-5.5");
});

test("complete:true appends a session.end at the last line's timestamp", () => {
  const events = rolloutEvents(
    [sessionMeta, userMessage, functionCall, functionCallOutput].join("\n"),
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
  expect(end.timestamp).toBe("2026-06-02T10:00:02.600Z");
  expect(events[events.length - 1]).toBe(end);
});

test("the rollout session.end carries the catch-all normalized reason, as Codex exposes none", () => {
  const events = rolloutEvents(
    [sessionMeta, userMessage, functionCall, functionCallOutput].join("\n"),
    { complete: true },
  );
  const end = events.find((e) => e.event_type === "session.end")!;
  expect(end.attributes.end_reason_normalized).toBe("other");
  expect(end.attributes.end_reason_native).toBeUndefined();
});

test("complete:false never produces a session.end, so an open conversation stays open", () => {
  const events = rolloutEvents(
    [sessionMeta, userMessage, functionCall, functionCallOutput].join("\n"),
    { complete: false },
  );
  expect(events.some((e) => e.event_type === "session.end")).toBe(false);
});

test("applyPatchFilePaths extracts the files an apply_patch touches from its headers", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/a.ts",
    "+content",
    "*** Update File: src/b.ts",
    "@@",
    "+more",
    "*** Delete File: src/c.ts",
    "*** End Patch",
  ].join("\n");
  expect(applyPatchFilePaths(patch).sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
  ]);
});

const customToolCall = line({
  timestamp: "2026-06-02T11:00:01.000Z",
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    name: "apply_patch",
    status: "completed",
    call_id: "call_patch01",
    input:
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n*** Add File: src/b.ts\n+y\n*** End Patch",
  },
});

test("an apply_patch tool call emits one file-edit tool.post per touched file from its patch text, keyed by call_id", () => {
  const events = rolloutEvents([sessionMeta, customToolCall].join("\n"), {
    complete: false,
  });
  const fileEdits = events.filter(
    (e) => e.event_type === "tool.post" && e.attributes.file_path !== undefined,
  );
  const paths = fileEdits.map((e) => e.attributes.file_path).sort();
  expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  for (const edit of fileEdits) {
    validate(edit);
    expect(validate.errors ?? []).toEqual([]);
    expect(edit.attributes.tool_name).toBe("apply_patch");
    expect(edit.attributes.tool_call_id).toBe("call_patch01");
  }
});

test("a file is churned once when a build emits both the patch input and a patch_apply_end for the same call", () => {
  const patchApplyEnd = line({
    timestamp: "2026-06-02T11:00:01.500Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      call_id: "call_patch01",
      success: true,
      status: "completed",
      changes: { "src/a.ts": { type: "update", move_path: null } },
    },
  });
  const events = rolloutEvents(
    [sessionMeta, customToolCall, patchApplyEnd].join("\n"),
    { complete: false },
  );
  const edits = events.filter(
    (e) =>
      e.event_type === "tool.post" && e.attributes.file_path === "src/a.ts",
  );
  expect(edits.length).toBe(1);
});

const webSearchCall = line({
  timestamp: "2026-06-02T10:00:04.000Z",
  type: "response_item",
  payload: {
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "bun current version", queries: [] },
  },
});

test("a web_search_call maps to a paired web_search tool span carrying the query", () => {
  const events = rolloutEvents([sessionMeta, webSearchCall].join("\n"), {
    complete: false,
  });
  const pre = events.find(
    (e) =>
      e.event_type === "tool.pre" && e.attributes.tool_name === "web_search",
  );
  const post = events.find(
    (e) =>
      e.event_type === "tool.post" && e.attributes.tool_name === "web_search",
  );
  expect(pre).toBeDefined();
  expect(post).toBeDefined();
  validate(pre!);
  expect(validate.errors ?? []).toEqual([]);
  validate(post!);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre!.span_name).toBe("tool:web_search");
  expect(pre!.attributes.query).toBe("bun current version");
  expect(post!.attributes.tool_call_id).toBe(pre!.attributes.tool_call_id);
});

const skillCall = line({
  timestamp: "2026-06-02T10:00:05.000Z",
  type: "response_item",
  payload: {
    type: "function_call",
    name: "Skill",
    arguments: '{"skill":"tdd","args":"build the feature"}',
    call_id: "call_skill01",
  },
});

test("a skill invocation surfaces skill_name on its tool.pre so skill usage is observable", () => {
  const events = rolloutEvents([sessionMeta, skillCall].join("\n"), {
    complete: false,
  });
  const pre = events.find(
    (e) => e.event_type === "tool.pre" && e.attributes.tool_name === "Skill",
  );
  expect(pre).toBeDefined();
  validate(pre!);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre!.attributes.skill_name).toBe("tdd");
});

const contextCompacted = line({
  timestamp: "2026-06-02T10:00:03.000Z",
  type: "event_msg",
  payload: { type: "context_compacted" },
});
const compactedLine = line({
  timestamp: "2026-06-02T10:00:03.010Z",
  type: "compacted",
  payload: { message: "<redacted>", replacement_history: [] },
});

test("a compaction is counted once even when both context_compacted and the compacted line appear", () => {
  const events = rolloutEvents(
    [sessionMeta, contextCompacted, compactedLine].join("\n"),
    { complete: false },
  );
  const compactions = events.filter((e) => e.event_type === "compaction");
  expect(compactions.length).toBe(1);
  validate(compactions[0]!);
  expect(validate.errors ?? []).toEqual([]);
  expect(compactions[0]!.span_phase).toBe("point");
  expect(compactions[0]!.span_name).toBe("compaction");
});

test("a function_call and its function_call_output pair into tool.pre/tool.post by call_id", () => {
  const events = rolloutEvents(
    [sessionMeta, functionCall, functionCallOutput].join("\n"),
    { complete: false },
  );
  const pre = events.find((e) => e.event_type === "tool.pre");
  const post = events.find((e) => e.event_type === "tool.post");
  expect(pre).toBeDefined();
  expect(post).toBeDefined();
  validate(pre!);
  expect(validate.errors ?? []).toEqual([]);
  validate(post!);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre!.span_phase).toBe("start");
  expect(post!.span_phase).toBe("end");
  expect(pre!.span_name).toBe("tool:exec_command");
  expect(pre!.attributes.tool_name).toBe("exec_command");
  expect(pre!.attributes.tool_call_id).toBe("call_shell01");
  expect(post!.attributes.tool_call_id).toBe("call_shell01");
});

test("a response_item user message maps to a user_prompt point event carrying the session id and per-session seq", () => {
  const events = rolloutEvents([sessionMeta, userPromptItem].join("\n"), {
    complete: false,
  });
  const prompts = events.filter((e) => e.event_type === "user_prompt");
  expect(prompts.length).toBe(1);
  const prompt = prompts[0]!;
  validate(prompt);
  expect(validate.errors ?? []).toEqual([]);
  expect(prompt.session_id).toBe(SESSION);
  expect(prompt.span_phase).toBe("point");
  expect(prompt.span_name).toBe("user_prompt");
  expect(prompt.timestamp).toBe("2026-06-02T10:00:00.400Z");
  // The first anchored event is seq 0, and the seq is part of the hashed event
  // so it matches the content fold's human_prompt anchor exactly.
  expect(prompt.attributes.seq).toBe("0");
  const expected = codexUserPrompt(
    {
      sessionId: SESSION,
      timestamp: "2026-06-02T10:00:00.400Z",
      cwd: "/work/sample-project",
    },
    0,
  );
  expect(eventHash(prompt).toString("hex")).toBe(
    eventHash(expected).toString("hex"),
  );
});

test("an event_msg user_message alone is the dedup twin and mints no user_prompt, so prompts are not double-counted", () => {
  const events = rolloutEvents([sessionMeta, userMessage].join("\n"), {
    complete: false,
  });
  expect(events.some((e) => e.event_type === "user_prompt")).toBe(false);
});

test("an injected machine user message produces no user_prompt event", () => {
  const envContext = line({
    timestamp: "2026-06-02T10:00:00.400Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/work</cwd>\n</environment_context>",
        },
      ],
    },
  });
  const events = rolloutEvents([sessionMeta, envContext].join("\n"), {
    complete: false,
  });
  expect(events.some((e) => e.event_type === "user_prompt")).toBe(false);
});

test("an assistant response_item message mints an agent.message point event carrying the per-session seq", () => {
  const assistantMsg = line({
    timestamp: "2026-06-02T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  });
  const events = rolloutEvents(
    [sessionMeta, userPromptItem, assistantMsg].join("\n"),
    { complete: false },
  );
  const messages = events.filter((e) => e.event_type === "agent.message");
  expect(messages.length).toBe(1);
  const message = messages[0]!;
  validate(message);
  expect(validate.errors ?? []).toEqual([]);
  expect(message.session_id).toBe(SESSION);
  expect(message.span_phase).toBe("point");
  expect(message.span_name).toBe("agent_message");
  // The user prompt took seq 0, so this assistant message is seq 1.
  expect(message.attributes.seq).toBe("1");
});
