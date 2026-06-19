/**
 * Fail-closed (ADR-0007) tests for the Codex rollout reader.
 *
 * The reader recognizes records by shape: it counts-and-surfaces a record type
 * it has never seen (benign vendor drift stays visible without failing a
 * readable transcript), and quarantines-and-surfaces a malformed load-bearing
 * record (a conversation message whose role or content part the reader cannot
 * recognize), never fabricating text. Both the structural and the content
 * paths are covered through the one `rolloutRead` return.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rolloutRead } from "../src/loader/rollout/codex-reader.ts";

const SAMPLES = join(import.meta.dir, "..", "samples");
function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const SESSION = "019e0000-1111-7000-8000-00000000bbbb";
const meta = line({
  timestamp: "2026-06-03T10:00:00.000Z",
  type: "session_meta",
  payload: {
    id: SESSION,
    cwd: "/work/p",
    originator: "codex_exec",
    source: "exec",
  },
});
const userMsg = line({
  timestamp: "2026-06-03T10:00:01.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
  },
});

test("an unknown record type is counted and surfaced, and the readable transcript still reads", () => {
  const unknown = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "event_msg",
    payload: { type: "brand_new_telemetry_record", value: 1 },
  });
  const result = rolloutRead([meta, userMsg, unknown].join("\n"), {
    complete: false,
  });
  expect(
    result.unknownRecordTypes["event_msg/brand_new_telemetry_record"],
  ).toBe(1);
  // The transcript still reads: the unknown record does not fail it.
  expect(result.content.filter((c) => c.kind === "human_prompt").length).toBe(
    1,
  );
  expect(result.quarantined.length).toBe(0);
});

test("a known auxiliary record type is not counted as unknown", () => {
  const tokenCount = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: null },
  });
  const result = rolloutRead([meta, userMsg, tokenCount].join("\n"), {
    complete: false,
  });
  expect(Object.keys(result.unknownRecordTypes)).toEqual([]);
});

test("a message with an unknown role is quarantined and surfaced, not counted or parsed", () => {
  const oddRole = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "moderator",
      content: [{ type: "input_text", text: "system policy" }],
    },
  });
  const result = rolloutRead([meta, oddRole].join("\n"), { complete: false });
  expect(result.quarantined.length).toBe(1);
  expect(result.quarantined[0]!.reason).toContain("moderator");
  expect(result.quarantined[0]!.rawLine).toBe(oddRole);
  // Quarantine is not the unknown-type bucket.
  expect(Object.keys(result.unknownRecordTypes)).toEqual([]);
});

test("a message content part of a never-seen type is quarantined, never fabricated into text", () => {
  const oddPart = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "holographic_text", data: "??" }],
    },
  });
  const result = rolloutRead([meta, oddPart].join("\n"), { complete: false });
  expect(result.quarantined.length).toBe(1);
  expect(result.quarantined[0]!.reason).toContain("holographic_text");
});

test("reasoning and developer messages are recognized-and-excluded, never counted as unknown drift", () => {
  const developerMsg = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: { type: "message", role: "developer", content: "permissions" },
  });
  const reasoning = line({
    timestamp: "2026-06-03T10:00:03.000Z",
    type: "response_item",
    payload: { type: "reasoning", summary: [], encrypted_content: "x" },
  });
  const agentReasoning = line({
    timestamp: "2026-06-03T10:00:04.000Z",
    type: "event_msg",
    payload: { type: "agent_reasoning", text: "**thought**" },
  });
  const result = rolloutRead(
    [meta, developerMsg, reasoning, agentReasoning].join("\n"),
    { complete: false },
  );
  expect(Object.keys(result.unknownRecordTypes)).toEqual([]);
  expect(result.quarantined.length).toBe(0);
});

test("the real fixtures read with no false unknowns and no false quarantines", () => {
  for (const name of [
    "rollout-codex-oldest-0.35.0.jsonl",
    "rollout-codex-recent-clean.jsonl",
    "rollout-codex-recent-devbox.jsonl",
    "rollout-codex-mid-rich-tools.jsonl",
    "rollout-codex-mid-guardian-subagent.jsonl",
    "rollout-codex-mid-error-edge.jsonl",
  ]) {
    const result = rolloutRead(fixture(name), { complete: true });
    expect(Object.keys(result.unknownRecordTypes), name).toEqual([]);
    expect(result.quarantined, name).toEqual([]);
  }
});
