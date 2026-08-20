import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnvFile,
  parseEnvFile,
  writeEnvTemplateIfAbsent,
} from "../src/cli/env-file.ts";

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

test("writeEnvTemplateIfAbsent writes a template when the file is absent", () => {
  const wrote = writeEnvTemplateIfAbsent(dir, false);
  expect(wrote).toBe(true);
  expect(existsSync(join(dir, "env"))).toBe(true);
});

test("writeEnvTemplateIfAbsent never touches an already-existing file, even an empty one", () => {
  writeFileSync(join(dir, "env"), "");
  const wrote = writeEnvTemplateIfAbsent(dir, false);
  expect(wrote).toBe(false);
  expect(readFileSync(join(dir, "env"), "utf8")).toBe("");
});

test("under dry run, writeEnvTemplateIfAbsent never creates a missing file", () => {
  const wrote = writeEnvTemplateIfAbsent(dir, true);
  expect(wrote).toBe(false);
  expect(existsSync(join(dir, "env"))).toBe(false);
});

test("the written template is entirely comments and documents the judge vars", () => {
  writeEnvTemplateIfAbsent(dir, false);
  const contents = readFileSync(join(dir, "env"), "utf8");
  expect(parseEnvFile(contents)).toEqual([]);
  for (const line of contents.split("\n")) {
    expect(line === "" || line.startsWith("#")).toBe(true);
  }
  expect(contents).toContain("REGIMEN_JUDGE_API_KEY");
  expect(contents).toContain("REGIMEN_JUDGE_BASE_URL");
  expect(contents).toContain("REGIMEN_JUDGE_MODEL");
  expect(contents).toContain("REGIMEN_JUDGE_VIA");
  expect(contents.toLowerCase()).toContain("loaded at cli startup");
});

test.skipIf(process.platform === "win32")(
  "the written template is readable only by its owner, since it holds an API key",
  () => {
    writeEnvTemplateIfAbsent(dir, false);
    const mode = statSync(join(dir, "env")).mode & 0o777;
    expect(mode).toBe(0o600);
  },
);
