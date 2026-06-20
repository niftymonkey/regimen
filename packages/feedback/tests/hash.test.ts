import { expect, test } from "bun:test";
import { canonicalJson, eventHash } from "../src/hash.ts";

test("canonicalJson sorts object keys lexically at every depth", () => {
  expect(canonicalJson({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
  expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(
    `{"outer":{"a":2,"z":1}}`,
  );
});

test("canonicalJson preserves array order and serializes primitives like JSON.stringify", () => {
  expect(canonicalJson([3, 1, 2])).toBe(`[3,1,2]`);
  expect(canonicalJson(null)).toBe("null");
  expect(canonicalJson(true)).toBe("true");
  expect(canonicalJson('a"b')).toBe(`"a\\"b"`);
  expect(canonicalJson(1.5)).toBe(`1.5`);
});

test("eventHash returns the same digest regardless of source key order", () => {
  const a = { harness: "claude", model: "x", attributes: { tool: "Edit" } };
  const b = { attributes: { tool: "Edit" }, model: "x", harness: "claude" };
  expect(eventHash(a).equals(eventHash(b))).toBe(true);
});

test("eventHash differs when any field changes", () => {
  const base = { event_type: "tool.pre", tool_call_id: "abc" };
  const mutated = { event_type: "tool.pre", tool_call_id: "abd" };
  expect(eventHash(base).equals(eventHash(mutated))).toBe(false);
});

test("eventHash returns a 32-byte digest suitable for a BLOB primary key", () => {
  expect(eventHash({ a: 1 }).length).toBe(32);
});
