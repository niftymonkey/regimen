import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { translateGemini } from "../src/loader/translators/gemini.ts";
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

const CAPTURED_AT = "2026-06-21T08:22:57.268Z";
const SESSION = "10f35d6f-357c-4ec2-9c10-53755fe12c1d";
const CWD = "/tmp/regimen-e2e-gemini.5NFVTq/work";

function envelope(payload: unknown): Envelope {
  return { harness: "gemini", captured_at: CAPTURED_AT, payload };
}

const sessionStart = {
  session_id: SESSION,
  transcript_path: "/home/mlo/.gemini/tmp/work/chats/session.jsonl",
  cwd: CWD,
  hook_event_name: "SessionStart",
  timestamp: "2026-06-21T08:22:57.224Z",
  source: "startup",
};

function mustEventFrom(env: Envelope) {
  const result = translateGemini(env);
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

const beforeAgent = {
  session_id: SESSION,
  transcript_path: "/home/mlo/.gemini/tmp/work/chats/session.jsonl",
  cwd: CWD,
  hook_event_name: "BeforeAgent",
  timestamp: "2026-06-21T08:22:57.277Z",
  prompt: "Fix the fizzbuzz.py bug so all asserts pass.",
};

test("SessionStart produces a schema-valid v1 session.start event stamped gemini", () => {
  const event = mustEvent(sessionStart);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("session.start");
  expect(event.harness).toBe("gemini");
  expect(event.session_id).toBe(SESSION);
  expect(event.timestamp).toBe(CAPTURED_AT);
});

const beforeTool = {
  session_id: SESSION,
  transcript_path: "/home/mlo/.gemini/tmp/work/chats/session.jsonl",
  cwd: CWD,
  hook_event_name: "BeforeTool",
  timestamp: "2026-06-21T08:23:15.329Z",
  tool_name: "read_file",
  tool_input: { file_path: "fizzbuzz.py" },
};
const afterTool = {
  session_id: SESSION,
  transcript_path: "/home/mlo/.gemini/tmp/work/chats/session.jsonl",
  cwd: CWD,
  hook_event_name: "AfterTool",
  timestamp: "2026-06-21T08:23:15.463Z",
  tool_name: "read_file",
  tool_input: { file_path: "fizzbuzz.py" },
  tool_response: { llmContent: "def fizzbuzz(n): ...", returnDisplay: "" },
};

test("BeforeAgent maps to a user_prompt point event (Gemini's user-prompt-submitted signal)", () => {
  const event = mustEvent(beforeAgent);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("user_prompt");
  expect(event.span_phase).toBe("point");
  expect(event.span_name).toBe("user_prompt");
});

test("BeforeTool maps to a tool.pre start span carrying the tool name", () => {
  const event = mustEvent(beforeTool);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("tool.pre");
  expect(event.span_phase).toBe("start");
  expect(event.span_name).toBe("tool:read_file");
  expect(event.attributes.tool_name).toBe("read_file");
});

const sessionEnd = {
  session_id: SESSION,
  transcript_path: "/home/mlo/.gemini/tmp/work/chats/session.jsonl",
  cwd: CWD,
  hook_event_name: "SessionEnd",
  timestamp: "2026-06-21T08:23:15.628Z",
  reason: "exit",
};

test("AfterTool maps to a tool.post end span carrying the tool name", () => {
  const post = mustEvent(afterTool);
  validate(post);
  expect(validate.errors ?? []).toEqual([]);
  expect(post.event_type).toBe("tool.post");
  expect(post.span_phase).toBe("end");
  expect(post.span_name).toBe("tool:read_file");
  expect(post.attributes.tool_name).toBe("read_file");
});

test("a tool span's tool_call_id falls back to its own envelope captured_at, since the Gemini hook payload carries no native tool-call id", () => {
  const preAt = "2026-06-21T08:23:15.412Z";
  const postAt = "2026-06-21T08:23:15.499Z";
  const pre = mustEventFrom({
    harness: "gemini",
    captured_at: preAt,
    payload: beforeTool,
  });
  const post = mustEventFrom({
    harness: "gemini",
    captured_at: postAt,
    payload: afterTool,
  });
  expect(pre.attributes.tool_call_id).toBe(preAt);
  expect(post.attributes.tool_call_id).toBe(postAt);
  expect(post.attributes.tool_call_id).not.toBe(pre.attributes.tool_call_id);
});

test("SessionEnd maps to a session.end carrying the native reason and the normalized reason", () => {
  const event = mustEvent(sessionEnd);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("session.end");
  expect(event.span_phase).toBe("end");
  expect(event.attributes.end_reason_native).toBe("exit");
  expect(event.attributes.end_reason_normalized).toBe("other");
});

test("trace_id is derived from session_id and shared across every mapped event", () => {
  const traceIds = new Set(
    [sessionStart, beforeAgent, beforeTool, afterTool, sessionEnd].map(
      (payload) => mustEvent(payload).trace_id,
    ),
  );
  expect(traceIds.size).toBe(1);
});

test("a Gemini hook event with no v1 mapping is skipped, not quarantined", () => {
  expect(
    translateGemini(
      envelope({ hook_event_name: "PreCompress", session_id: SESSION }),
    ).kind,
  ).toBe("skip");
  expect(
    translateGemini(
      envelope({ hook_event_name: "BeforeModel", session_id: SESSION }),
    ).kind,
  ).toBe("skip");
});

test("a payload missing hook_event_name is quarantined", () => {
  expect(translateGemini(envelope({ session_id: SESSION })).kind).toBe(
    "quarantine",
  );
});

test("a payload that is not an object is quarantined", () => {
  expect(translateGemini(envelope("oops")).kind).toBe("quarantine");
  expect(translateGemini(envelope(null)).kind).toBe("quarantine");
});

test("dispatchLine routes a gemini envelope through the Gemini translator", () => {
  const line = JSON.stringify({
    harness: "gemini",
    captured_at: CAPTURED_AT,
    payload: beforeTool,
  });
  const result = dispatchLine(line);
  if (result.kind !== "event") {
    throw new Error(
      `expected event, got ${result.kind === "quarantine" ? result.reason : result.kind}`,
    );
  }
  expect(result.event.event_type).toBe("tool.pre");
  expect(result.event.harness).toBe("gemini");
  expect(result.event.timestamp).toBe(CAPTURED_AT);
});
