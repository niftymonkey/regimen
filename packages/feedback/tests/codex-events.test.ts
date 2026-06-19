/**
 * Producer-side unit tests for the shared Codex v1 event vocabulary.
 *
 * The structural builders in `codex-events.ts` are the single source of truth
 * both Codex producers (the hook translator and the rollout reader) emit
 * through. These tests pin the shape of the builders S2 adds: the new
 * `agent.message` event that gives assistant visible text a clean
 * `{eventHash}` anchor, and the optional per-session sequence index that makes
 * the rollout path's prompt and agent-message hashes collision-proof within
 * one transcript read.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  codexAgentMessage,
  codexUserPrompt,
  type CodexEventBase,
} from "../src/loader/translators/codex-events.ts";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const BASE: CodexEventBase = {
  sessionId: "019e8c20-4491-7ea3-b809-d6586a5a72b8",
  timestamp: "2026-06-03T06:16:38.826Z",
  model: "gpt-5.5",
};

test("codexAgentMessage builds a schema-valid agent.message point event for assistant visible text", () => {
  const event = codexAgentMessage(BASE);
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
  expect(event.event_type).toBe("agent.message");
  expect(event.span_phase).toBe("point");
  expect(event.span_name).toBe("agent_message");
  expect(event.harness).toBe("codex");
  expect(event.session_id).toBe(BASE.sessionId);
  expect(event.timestamp).toBe(BASE.timestamp);
});

test("the optional sequence index makes two same-timestamp prompts differ, so their event hashes cannot collide", () => {
  const first = codexUserPrompt(BASE, 0);
  const second = codexUserPrompt(BASE, 1);
  expect(first.attributes.seq).toBe("0");
  expect(second.attributes.seq).toBe("1");
  validate(first);
  expect(validate.errors ?? []).toEqual([]);
  expect(first).not.toEqual(second);
});

test("the rollout-set sequence index stays schema-valid on the new agent.message event", () => {
  const event = codexAgentMessage(BASE, 3);
  expect(event.attributes.seq).toBe("3");
  validate(event);
  expect(validate.errors ?? []).toEqual([]);
});

test("omitting the sequence index leaves attributes empty, so the hook path is unchanged", () => {
  expect(codexUserPrompt(BASE).attributes).toEqual({});
  expect(codexAgentMessage(BASE).attributes).toEqual({});
});
