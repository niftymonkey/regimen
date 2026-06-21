import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { translateCopilot } from "../src/loader/translators/copilot.ts";
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

const CAPTURED_AT = "2026-06-21T08:28:27.558Z";
const SESSION = "117c0a93-5a36-4f95-82df-cff186b2b5ae";
const CWD = "/tmp/regimen-e2e-copilot.2N50ug/work";

function envelope(payload: unknown): Envelope {
  return { harness: "copilot", captured_at: CAPTURED_AT, payload };
}

function mustEventFrom(env: Envelope) {
  const result = translateCopilot(env);
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  return result.event;
}

function mustEvent(payload: unknown) {
  return mustEventFrom(envelope(payload));
}

const sessionStart = {
  sessionId: SESSION,
  cwd: CWD,
  timestamp: 1782030507514,
  source: "new",
  initialPrompt:
    "The file fizzbuzz.py in this directory has a bug: fizzbuzz(15) returns the wrong value because the order of the divisibility checks is wrong.",
};

test("the session-start shape (source + initialPrompt) produces a schema-valid v1 session.start event stamped copilot", () => {
  const event = mustEvent(sessionStart);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("session.start");
  expect(event.harness).toBe("copilot");
  expect(event.session_id).toBe(SESSION);
  expect(event.timestamp).toBe(CAPTURED_AT);
});

const userPrompt = {
  sessionId: SESSION,
  cwd: CWD,
  timestamp: 1782030507405,
  prompt:
    "The file fizzbuzz.py in this directory has a bug: fix the bug so all the asserts in the file pass.",
};

test("the prompt shape maps to a user_prompt point event", () => {
  const event = mustEvent(userPrompt);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("user_prompt");
  expect(event.span_phase).toBe("point");
  expect(event.span_name).toBe("user_prompt");
});

const toolPre = {
  sessionId: SESSION,
  cwd: CWD,
  timestamp: 1782030515688,
  toolName: "view",
  toolArgs: '{"path":"/tmp/regimen-e2e-copilot.2N50ug/work/fizzbuzz.py"}',
};

test("the toolName shape without toolResult maps to a tool.pre start span carrying the tool name", () => {
  const event = mustEvent(toolPre);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("tool.pre");
  expect(event.span_phase).toBe("start");
  expect(event.span_name).toBe("tool:view");
  expect(event.attributes.tool_name).toBe("view");
});

const toolPost = {
  sessionId: SESSION,
  cwd: CWD,
  timestamp: 1782030515736,
  toolName: "view",
  toolArgs: '{"path":"/tmp/regimen-e2e-copilot.2N50ug/work/fizzbuzz.py"}',
  toolResult: { resultType: "success", textResultForLlm: "all asserts passed" },
};

test("the toolName shape with toolResult discriminates to a tool.post end span carrying the tool name", () => {
  const event = mustEvent(toolPost);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("tool.post");
  expect(event.span_phase).toBe("end");
  expect(event.span_name).toBe("tool:view");
  expect(event.attributes.tool_name).toBe("view");
});

const sessionEnd = {
  sessionId: SESSION,
  cwd: CWD,
  timestamp: 1782030523106,
  reason: "complete",
};

test("the reason shape maps to a session.end carrying the native reason and the normalized reason", () => {
  const event = mustEvent(sessionEnd);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("session.end");
  expect(event.span_phase).toBe("end");
  expect(event.attributes.end_reason_native).toBe("complete");
  expect(event.attributes.end_reason_normalized).toBe("other");
});

test("a tool span's tool_call_id falls back to its own envelope captured_at, since the Copilot hook payload carries no native tool-call id", () => {
  const preAt = "2026-06-21T08:28:35.726Z";
  const postAt = "2026-06-21T08:28:35.780Z";
  const pre = mustEventFrom({
    harness: "copilot",
    captured_at: preAt,
    payload: toolPre,
  });
  const post = mustEventFrom({
    harness: "copilot",
    captured_at: postAt,
    payload: toolPost,
  });
  expect(pre.attributes.tool_call_id).toBe(preAt);
  expect(post.attributes.tool_call_id).toBe(postAt);
  expect(post.attributes.tool_call_id).not.toBe(pre.attributes.tool_call_id);
});

test("trace_id is derived from session_id and shared across every inferred event", () => {
  const traceIds = new Set(
    [sessionStart, userPrompt, toolPre, toolPost, sessionEnd].map(
      (payload) => mustEvent(payload).trace_id,
    ),
  );
  expect(traceIds.size).toBe(1);
});

test("an unrecognized shape is skipped, not quarantined", () => {
  expect(
    translateCopilot(envelope({ sessionId: SESSION, cwd: CWD })).kind,
  ).toBe("skip");
});

test("a payload that is not an object is quarantined", () => {
  expect(translateCopilot(envelope("oops")).kind).toBe("quarantine");
  expect(translateCopilot(envelope(null)).kind).toBe("quarantine");
});

test("dispatchLine routes a copilot envelope through the Copilot translator", () => {
  const line = JSON.stringify({
    harness: "copilot",
    captured_at: CAPTURED_AT,
    payload: toolPre,
  });
  const result = dispatchLine(line);
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  expect(result.event.event_type).toBe("tool.pre");
  expect(result.event.harness).toBe("copilot");
  expect(result.event.timestamp).toBe(CAPTURED_AT);
});
