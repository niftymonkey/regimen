import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/cli/env-file.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "regimen-env-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a missing env file is a silent no-op", () => {
  const target: NodeJS.ProcessEnv = {};
  loadEnvFile(dir, target);
  expect(target).toEqual({});
});

test("a simple KEY=value line is applied to the target", () => {
  writeFileSync(join(dir, "env"), "REGIMEN_JUDGE_MODEL=gpt-4o\n");
  const target: NodeJS.ProcessEnv = {};
  loadEnvFile(dir, target);
  expect(target.REGIMEN_JUDGE_MODEL).toBe("gpt-4o");
});

test("an already-set target value is not overwritten by the file", () => {
  writeFileSync(join(dir, "env"), "REGIMEN_JUDGE_MODEL=gpt-4o\n");
  const target: NodeJS.ProcessEnv = { REGIMEN_JUDGE_MODEL: "claude-opus" };
  loadEnvFile(dir, target);
  expect(target.REGIMEN_JUDGE_MODEL).toBe("claude-opus");
});

test("comments, blank lines, and malformed lines are skipped", () => {
  writeFileSync(
    join(dir, "env"),
    [
      "# a comment",
      "",
      "   ",
      "not a valid line",
      "=no key",
      "REGIMEN_JUDGE_MODEL=gpt-4o",
    ].join("\n"),
  );
  const target: NodeJS.ProcessEnv = {};
  loadEnvFile(dir, target);
  expect(target).toEqual({ REGIMEN_JUDGE_MODEL: "gpt-4o" });
});

test("a value containing = splits only on the first =", () => {
  writeFileSync(
    join(dir, "env"),
    "REGIMEN_JUDGE_BASE_URL=https://example.com/v1?x=1&y=2\n",
  );
  const target: NodeJS.ProcessEnv = {};
  loadEnvFile(dir, target);
  expect(target.REGIMEN_JUDGE_BASE_URL).toBe("https://example.com/v1?x=1&y=2");
});
