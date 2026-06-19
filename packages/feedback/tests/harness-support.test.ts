import { expect, test } from "bun:test";
import {
  harnessSupport,
  resolveHarnessFromEnvironment,
} from "../src/harness/support.ts";

test("harnessSupport(codex) returns a bundle with descriptor, reader, resolver", () => {
  const support = harnessSupport("codex");
  expect(support).toBeDefined();
  expect(support?.descriptor.contract.harness).toBe("codex");
  expect(typeof support?.reader.read).toBe("function");
  expect(typeof support?.resolver.resolveCurrent).toBe("function");
  expect(typeof support?.resolver.locate).toBe("function");
});

test("harnessSupport for a valid-but-unregistered harness returns undefined", () => {
  expect(harnessSupport("gemini")).toBeUndefined();
});

test("resolveHarnessFromEnvironment detects codex from CODEX_THREAD_ID", () => {
  expect(resolveHarnessFromEnvironment({ CODEX_THREAD_ID: "t-1" })).toBe(
    "codex",
  );
});

test("resolveHarnessFromEnvironment detects claude from CLAUDECODE", () => {
  expect(resolveHarnessFromEnvironment({ CLAUDECODE: "1" })).toBe("claude");
});

test("resolveHarnessFromEnvironment detects gemini from GEMINI_CLI", () => {
  expect(resolveHarnessFromEnvironment({ GEMINI_CLI: "1" })).toBe("gemini");
});

test("resolveHarnessFromEnvironment detects copilot from COPILOT_CLI", () => {
  expect(resolveHarnessFromEnvironment({ COPILOT_CLI: "1" })).toBe("copilot");
});

test("resolveHarnessFromEnvironment REGIMEN_HARNESS overrides a present marker", () => {
  expect(
    resolveHarnessFromEnvironment({
      REGIMEN_HARNESS: "gemini",
      CODEX_THREAD_ID: "t-1",
    }),
  ).toBe("gemini");
});

test("resolveHarnessFromEnvironment throws on an invalid REGIMEN_HARNESS", () => {
  expect(() =>
    resolveHarnessFromEnvironment({ REGIMEN_HARNESS: "bogus" }),
  ).toThrow("REGIMEN_HARNESS");
});

test("resolveHarnessFromEnvironment returns undefined with no override and no marker", () => {
  expect(resolveHarnessFromEnvironment({})).toBeUndefined();
});

test("resolveHarnessFromEnvironment ignores an empty marker value", () => {
  expect(
    resolveHarnessFromEnvironment({ CODEX_THREAD_ID: "" }),
  ).toBeUndefined();
});
