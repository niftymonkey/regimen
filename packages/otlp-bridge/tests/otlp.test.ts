import { test, expect } from "bun:test";
import { mintSpanId, toUnixNano } from "../src/otlp.ts";

const SECONDS = BigInt(Date.parse("2026-05-18T02:00:00Z") / 1000);

test("toUnixNano preserves microsecond precision", () => {
  const wholeSeconds = BigInt(Date.parse("2026-05-17T21:42:49Z") / 1000);
  const expected = (wholeSeconds * 1_000_000_000n + 148833000n).toString();
  expect(toUnixNano("2026-05-17T21:42:49.148833Z")).toBe(expected);
});

test("toUnixNano keeps full nanosecond precision and truncates beyond it", () => {
  const base = SECONDS * 1_000_000_000n;
  expect(toUnixNano("2026-05-18T02:00:00.123456789Z")).toBe(
    (base + 123456789n).toString(),
  );
  // More than nine fractional digits are truncated, not rounded.
  expect(toUnixNano("2026-05-18T02:00:00.123456789999Z")).toBe(
    (base + 123456789n).toString(),
  );
});

test("toUnixNano handles a timestamp with no fractional seconds", () => {
  expect(toUnixNano("2026-05-18T02:00:00Z")).toBe(
    (SECONDS * 1_000_000_000n).toString(),
  );
});

test("toUnixNano throws on an unparseable timestamp", () => {
  expect(() => toUnixNano("not-a-timestamp")).toThrow();
  expect(() => toUnixNano("2026-13-99T02:00:00Z")).toThrow();
});

test("mintSpanId returns a 16-hex-char id", () => {
  expect(mintSpanId("session:sess-1")).toMatch(/^[0-9a-f]{16}$/);
});

test("mintSpanId is deterministic per seed and distinct across seeds", () => {
  expect(mintSpanId("session:sess-1")).toBe(mintSpanId("session:sess-1"));
  expect(mintSpanId("session:sess-1")).not.toBe(mintSpanId("session:sess-2"));
  expect(mintSpanId("tool:tc-1")).not.toBe(mintSpanId("session:sess-1"));
});
