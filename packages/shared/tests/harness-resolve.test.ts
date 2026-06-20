/**
 * The shared harness-resolution policy: explicit REGIMEN_HARNESS wins (and
 * throws on an unknown value), else the first present-and-non-empty CLI-set
 * marker, else undefined. Pure: the environment is passed in as a plain object,
 * no process.env is read or mutated.
 */
import { expect, test } from "bun:test";
import {
  HARNESS_ENV_MARKERS,
  resolveHarnessFromEnvironment,
} from "../src/harness/resolve.ts";

test("an explicit REGIMEN_HARNESS wins", () => {
  expect(resolveHarnessFromEnvironment({ REGIMEN_HARNESS: "codex" })).toBe(
    "codex",
  );
});

test("an unknown REGIMEN_HARNESS throws instead of falling through", () => {
  expect(() =>
    resolveHarnessFromEnvironment({ REGIMEN_HARNESS: "bogus" }),
  ).toThrow("REGIMEN_HARNESS");
});

test("detects codex from the CODEX_THREAD_ID marker", () => {
  expect(resolveHarnessFromEnvironment({ CODEX_THREAD_ID: "t-1" })).toBe(
    "codex",
  );
});

test("detects claude from the CLAUDECODE marker", () => {
  expect(resolveHarnessFromEnvironment({ CLAUDECODE: "1" })).toBe("claude");
});

test("detects gemini from the GEMINI_CLI marker", () => {
  expect(resolveHarnessFromEnvironment({ GEMINI_CLI: "1" })).toBe("gemini");
});

test("detects copilot from the COPILOT_CLI marker", () => {
  expect(resolveHarnessFromEnvironment({ COPILOT_CLI: "1" })).toBe("copilot");
});

test("HARNESS_ENV_MARKERS covers all four CLI-set markers", () => {
  expect(HARNESS_ENV_MARKERS.get("claude")).toBe("CLAUDECODE");
  expect(HARNESS_ENV_MARKERS.get("codex")).toBe("CODEX_THREAD_ID");
  expect(HARNESS_ENV_MARKERS.get("gemini")).toBe("GEMINI_CLI");
  expect(HARNESS_ENV_MARKERS.get("copilot")).toBe("COPILOT_CLI");
});

test("an explicit override beats a present marker", () => {
  expect(
    resolveHarnessFromEnvironment({
      REGIMEN_HARNESS: "gemini",
      CODEX_THREAD_ID: "t-1",
    }),
  ).toBe("gemini");
});

test("returns undefined when undetermined (no override, no marker)", () => {
  expect(resolveHarnessFromEnvironment({})).toBeUndefined();
});

test("ignores an empty marker value", () => {
  expect(
    resolveHarnessFromEnvironment({ CODEX_THREAD_ID: "" }),
  ).toBeUndefined();
});
