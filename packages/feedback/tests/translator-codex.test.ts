import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { translateCodex } from "../src/loader/translators/codex.ts";
import { dispatchLine } from "../src/loader/translators/index.ts";
import type { Envelope } from "../src/envelope.ts";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const CAPTURED_AT = "2026-06-02T12:00:00.000Z";
const SESSION = "codex-test-7f3a";

function envelope(payload: unknown): Envelope {
  return { harness: "codex", captured_at: CAPTURED_AT, payload };
}

const sessionStart = {
  hook_event_name: "SessionStart",
  session_id: SESSION,
  source: "startup",
  model: "gpt-5.5",
};
const userPrompt = {
  hook_event_name: "UserPromptSubmit",
  session_id: SESSION,
  turn_id: "turn_1",
  prompt: "add a test",
};
const preCompact = {
  hook_event_name: "PreCompact",
  session_id: SESSION,
  turn_id: "turn_1",
  trigger: "auto",
};
const preToolUse = {
  hook_event_name: "PreToolUse",
  session_id: SESSION,
  turn_id: "turn_1",
  tool_name: "Bash",
  tool_use_id: "call_abc123",
  tool_input: { command: "ls -la" },
};
const postToolUse = {
  hook_event_name: "PostToolUse",
  session_id: SESSION,
  turn_id: "turn_1",
  tool_name: "Bash",
  tool_use_id: "call_abc123",
  tool_input: { command: "ls -la" },
  tool_response: { exit_code: 0, stdout: "..." },
};

function mustEvent(payload: unknown) {
  const result = translateCodex(envelope(payload));
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  return result.event;
}

test("SessionStart produces a schema-valid v1 session.start event stamped codex", () => {
  const event = mustEvent(sessionStart);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("session.start");
  expect(event.harness).toBe("codex");
  expect(event.model).toBe("gpt-5.5");
  expect(event.timestamp).toBe(CAPTURED_AT);
});

test("cwd is recorded from the payload as a schema-valid field anchoring the conversation", () => {
  const event = mustEvent({
    hook_event_name: "SessionStart",
    session_id: SESSION,
    source: "startup",
    cwd: "/Users/markd/work/service",
  });
  expect(event.cwd).toBe("/Users/markd/work/service");
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
});

test("UserPromptSubmit maps to a user_prompt point event", () => {
  const event = mustEvent(userPrompt);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("user_prompt");
  expect(event.span_phase).toBe("point");
  expect(event.span_name).toBe("user_prompt");
});

test("PreCompact maps to a compaction point event carrying the trigger", () => {
  const event = mustEvent(preCompact);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("compaction");
  expect(event.span_phase).toBe("point");
  expect(event.span_name).toBe("compaction");
  expect(event.attributes.trigger).toBe("auto");
});

test("tool.pre and tool.post pair by tool_call_id so a downstream reader can pair them", () => {
  const pre = mustEvent(preToolUse);
  const post = mustEvent(postToolUse);
  validate(pre);
  expect(validate.errors ?? []).toEqual([]);
  validate(post);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre.event_type).toBe("tool.pre");
  expect(post.event_type).toBe("tool.post");
  expect(pre.span_phase).toBe("start");
  expect(post.span_phase).toBe("end");
  expect(pre.attributes.tool_name).toBe("Bash");
  expect(pre.attributes.tool_call_id).toBe("call_abc123");
  expect(post.attributes.tool_call_id).toBe(pre.attributes.tool_call_id);
  expect(pre.span_name).toBe("tool:Bash");
});

test("a Skill tool event surfaces skill_name from tool_input so skill usage is observable", () => {
  const pre = mustEvent({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    turn_id: "turn_1",
    tool_name: "Skill",
    tool_use_id: "call_skill_1",
    tool_input: { skill: "tdd" },
  });
  validate(pre);
  expect(validate.errors ?? []).toEqual([]);
  expect(pre.attributes.skill_name).toBe("tdd");
});

test("a non-skill tool event carries no skill_name attribute", () => {
  expect(mustEvent(preToolUse).attributes.skill_name).toBeUndefined();
});

test("trace_id is derived from session_id and shared across every event", () => {
  const traceIds = new Set(
    [sessionStart, userPrompt, preToolUse, postToolUse, preCompact].map(
      (payload) => mustEvent(payload).trace_id,
    ),
  );
  expect(traceIds.size).toBe(1);
});

test("a Codex hook event with no v1 mapping is skipped, not quarantined (Codex has no SessionEnd hook)", () => {
  expect(
    translateCodex(envelope({ hook_event_name: "Stop", session_id: SESSION }))
      .kind,
  ).toBe("skip");
  expect(
    translateCodex(
      envelope({ hook_event_name: "SessionEnd", session_id: SESSION }),
    ).kind,
  ).toBe("skip");
});

test("a payload missing hook_event_name is quarantined", () => {
  expect(translateCodex(envelope({ session_id: SESSION })).kind).toBe(
    "quarantine",
  );
});

test("a payload that is not an object is quarantined", () => {
  expect(translateCodex(envelope("oops")).kind).toBe("quarantine");
  expect(translateCodex(envelope(null)).kind).toBe("quarantine");
});

test("dispatchLine routes a codex envelope through the Codex translator", () => {
  const line = JSON.stringify({
    harness: "codex",
    captured_at: CAPTURED_AT,
    payload: preToolUse,
  });
  const result = dispatchLine(line);
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  expect(result.event.event_type).toBe("tool.pre");
  expect(result.event.harness).toBe("codex");
  expect(result.event.timestamp).toBe(CAPTURED_AT);
});
