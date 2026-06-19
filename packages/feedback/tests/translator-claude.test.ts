import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { translateClaude } from "../src/loader/translators/claude.ts";
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

const CAPTURED_AT = "2026-05-21T12:00:00.000Z";
const SESSION = "claude-test-7f3a";

function envelope(payload: unknown): Envelope {
  return { harness: "claude", captured_at: CAPTURED_AT, payload };
}

const sessionStart = {
  hook_event_name: "SessionStart",
  session_id: SESSION,
  source: "startup",
  model: "claude-opus-4-7",
};
const userPrompt = {
  hook_event_name: "UserPromptSubmit",
  session_id: SESSION,
  prompt: "add a test",
};
const preToolUse = {
  hook_event_name: "PreToolUse",
  session_id: SESSION,
  tool_name: "Edit",
  tool_use_id: "toolu_abc123",
  tool_input: {},
};
const postToolUse = {
  hook_event_name: "PostToolUse",
  session_id: SESSION,
  tool_name: "Edit",
  tool_use_id: "toolu_abc123",
  tool_result: "ok",
};
const sessionEnd = { hook_event_name: "SessionEnd", session_id: SESSION };

function mustEvent(payload: unknown) {
  const result = translateClaude(envelope(payload));
  if (result.kind !== "event") {
    throw new Error(`expected event, got ${result.kind}`);
  }
  return result.event;
}

test("each mapped hook event produces a schema-valid v1 event", () => {
  const cases = [sessionStart, userPrompt, preToolUse, postToolUse, sessionEnd];
  for (const payload of cases) {
    const event = mustEvent(payload);
    validate(event);
    expect(validate.errors ?? []).toEqual([]);
  }
});

test("the v1 event timestamp is the envelope's captured_at, not the loader's clock", () => {
  expect(mustEvent(sessionStart).timestamp).toBe(CAPTURED_AT);
});

test("a SessionEnd from a real /exit capture carries the native and normalized end reason", () => {
  const event = mustEvent({
    hook_event_name: "SessionEnd",
    session_id: SESSION,
    reason: "prompt_input_exit",
  });
  expect(event.event_type).toBe("session.end");
  expect(event.attributes.end_reason_native).toBe("prompt_input_exit");
  expect(event.attributes.end_reason_normalized).toBe("user_exit");
});

test("a SessionEnd with no reason carries the catch-all normalized reason and no native reason", () => {
  const event = mustEvent(sessionEnd);
  expect(event.event_type).toBe("session.end");
  expect(event.attributes.end_reason_native).toBeUndefined();
  expect(event.attributes.end_reason_normalized).toBe("other");
});

test("model is recorded when the payload carries one and absent otherwise", () => {
  expect(mustEvent(sessionStart).model).toBe("claude-opus-4-7");
  expect(mustEvent(userPrompt).model).toBeUndefined();
});

test("cwd is recorded from the payload as a schema-valid field anchoring the conversation", () => {
  const event = mustEvent({
    hook_event_name: "SessionStart",
    session_id: SESSION,
    source: "startup",
    cwd: "/home/mlo/dev/regimen",
  });
  expect(event.cwd).toBe("/home/mlo/dev/regimen");
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
});

test("tool.pre and tool.post share tool_call_id so a downstream reader can pair them", () => {
  const pre = mustEvent(preToolUse);
  const post = mustEvent(postToolUse);
  expect(pre.attributes.tool_call_id).toBe("toolu_abc123");
  expect(post.attributes.tool_call_id).toBe(pre.attributes.tool_call_id);
  expect(pre.span_phase).toBe("start");
  expect(post.span_phase).toBe("end");
  expect(pre.attributes.tool_name).toBe("Edit");
});

test("Edit tool events surface file_path from tool_input so per-file churn can be measured", () => {
  const pre = mustEvent({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "Edit",
    tool_use_id: "toolu_edit_1",
    tool_input: { file_path: "/repo/src/store.ts" },
  });
  expect(pre.attributes.file_path).toBe("/repo/src/store.ts");
});

test("Skill tool events surface skill_name from tool_input so skill usage is observable", () => {
  const pre = mustEvent({
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "Skill",
    tool_use_id: "toolu_skill_1",
    tool_input: { skill: "tdd", args: "build the feature" },
  });
  const post = mustEvent({
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    tool_name: "Skill",
    tool_use_id: "toolu_skill_1",
    tool_input: { skill: "tdd", args: "build the feature" },
    tool_response: {},
  });
  expect(pre.attributes.skill_name).toBe("tdd");
  expect(post.attributes.skill_name).toBe("tdd");
  expect(pre.attributes.tool_name).toBe("Skill");
});

test("a non-skill tool event carries no skill_name attribute", () => {
  expect(mustEvent(preToolUse).attributes.skill_name).toBeUndefined();
});

test("trace_id is derived from session_id and shared across every event", () => {
  const traceIds = new Set(
    [sessionStart, userPrompt, preToolUse, postToolUse, sessionEnd].map(
      (payload) => mustEvent(payload).trace_id,
    ),
  );
  expect(traceIds.size).toBe(1);
});

test("a Claude hook event with no v1 mapping is skipped, not quarantined", () => {
  const result = translateClaude(
    envelope({ hook_event_name: "Notification", session_id: SESSION }),
  );
  expect(result.kind).toBe("skip");
});

test("PreCompact maps to a compaction point event with the trigger attribute", () => {
  const result = translateClaude(
    envelope({
      hook_event_name: "PreCompact",
      session_id: SESSION,
      trigger: "manual",
      custom_instructions: null,
    }),
  );
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  expect(result.event.event_type).toBe("compaction");
  expect(result.event.span_phase).toBe("point");
  expect(result.event.span_name).toBe("compaction");
  expect(result.event.attributes.trigger).toBe("manual");
});

test("PostCompact is skipped (the schema records one compaction event per compaction, anchored on the pre signal)", () => {
  const result = translateClaude(
    envelope({
      hook_event_name: "PostCompact",
      session_id: SESSION,
      trigger: "manual",
    }),
  );
  expect(result.kind).toBe("skip");
});

test("a payload missing hook_event_name is quarantined", () => {
  const result = translateClaude(envelope({ session_id: SESSION }));
  expect(result.kind).toBe("quarantine");
});

test("a payload that is not an object is quarantined", () => {
  expect(translateClaude(envelope("oops")).kind).toBe("quarantine");
  expect(translateClaude(envelope(null)).kind).toBe("quarantine");
});

test("dispatchLine routes an envelope through the Claude translator", () => {
  const line = JSON.stringify({
    harness: "claude",
    captured_at: CAPTURED_AT,
    payload: preToolUse,
  });
  const result = dispatchLine(line);
  if (result.kind !== "event") throw new Error("expected event");
  expect(result.event.event_type).toBe("tool.pre");
  expect(result.event.timestamp).toBe(CAPTURED_AT);
});

test("dispatchLine accepts a v1 event line with no payload key (cutover compatibility)", () => {
  const event = {
    schema_version: 1,
    timestamp: CAPTURED_AT,
    session_id: SESSION,
    harness: "claude",
    event_type: "gate.denial",
    trace_id: "0123456789abcdef0123456789abcdef",
    span_phase: "point",
    span_name: "gate:rm-rf-guard",
    attributes: {
      gate_id: "rm-rf-guard",
      tool_name: "Bash",
      tool_call_id: "toolu_x",
    },
  };
  const result = dispatchLine(JSON.stringify(event));
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  expect(result.event.event_type).toBe("gate.denial");
  expect(result.event.attributes.gate_id).toBe("rm-rf-guard");
});

test("dispatchLine preserves cwd on an already-translated v1 event line", () => {
  const event = {
    schema_version: 1,
    timestamp: CAPTURED_AT,
    session_id: SESSION,
    harness: "claude",
    cwd: "/home/mlo/dev/regimen",
    event_type: "session.start",
    trace_id: "0123456789abcdef0123456789abcdef",
    span_phase: "start",
    span_name: "session",
    attributes: {},
  };
  const result = dispatchLine(JSON.stringify(event));
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  expect(result.event.cwd).toBe("/home/mlo/dev/regimen");
});

test("dispatchLine quarantines a malformed JSON line", () => {
  const result = dispatchLine("not-json{");
  expect(result.kind).toBe("quarantine");
});

test("dispatchLine quarantines an envelope with an unknown harness", () => {
  const line = JSON.stringify({
    harness: "made-up",
    captured_at: CAPTURED_AT,
    payload: preToolUse,
  });
  const result = dispatchLine(line);
  expect(result.kind).toBe("quarantine");
});

test("dispatchLine quarantines an envelope missing harness or captured_at", () => {
  expect(
    dispatchLine(JSON.stringify({ captured_at: CAPTURED_AT, payload: {} }))
      .kind,
  ).toBe("quarantine");
  expect(
    dispatchLine(JSON.stringify({ harness: "claude", payload: {} })).kind,
  ).toBe("quarantine");
});

test("dispatchLine quarantines a v1-shaped line with an unsupported schema_version", () => {
  const result = dispatchLine(
    JSON.stringify({
      schema_version: 999,
      timestamp: CAPTURED_AT,
      session_id: SESSION,
      harness: "claude",
      event_type: "tool.pre",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_phase: "start",
      span_name: "tool:Edit",
      attributes: { tool_name: "Edit", tool_call_id: "toolu_x" },
    }),
  );
  expect(result.kind).toBe("quarantine");
});
