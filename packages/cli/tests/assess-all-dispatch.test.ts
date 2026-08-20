/**
 * The `regimen assess --all` DISPATCH: argv routes to the bulk sweep facade
 * rather than the single-session judge. Driven in-process through runCli against
 * a temp data dir with an empty store, so no real conversation is judged and the
 * host store is never touched. No judge backend is configured: the key is deleted
 * and `--judge-via api` forces the HTTP backend, so resolving a judge would
 * throw. The empty-store sweep must still succeed, which proves it short-circuits
 * on toJudge === 0 BEFORE backend resolution rather than relying on a configured
 * judge. The interactive between-batch prompt is not reached (nothing to judge).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../feedback/src/store.ts";
import { runCli } from "../src/cli/index.ts";

const MANAGED_ENV = [
  "REGIMEN_DATA_DIR",
  "REGIMEN_HARNESS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "REGIMEN_JUDGE_API_KEY",
  "REGIMEN_JUDGE_BASE_URL",
  "REGIMEN_JUDGE_MODEL",
];

/**
 * Blank every judge credential this process might inherit. `runCli` loads
 * `~/.config/regimen/env` before dispatch, so without this a dispatch test can
 * reach the engineer's real judge endpoint and spend a metered call.
 */
function withoutJudgeConfig(): void {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  process.env.REGIMEN_JUDGE_API_KEY = "";
  process.env.REGIMEN_JUDGE_BASE_URL = "";
  process.env.REGIMEN_JUDGE_MODEL = "";
}

let savedEnv: Record<string, string | undefined>;
let savedWrite: typeof process.stdout.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  savedWrite = process.stdout.write.bind(process.stdout);
});

afterEach(() => {
  process.stdout.write = savedWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-sweep-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

test("regimen assess --all routes to the bulk sweep and reports an empty store", async () => {
  const dataDir = tempDataDir();
  process.env.REGIMEN_DATA_DIR = dataDir;
  // No judge backend: deleting the key and forcing --judge-via api means
  // resolving one would throw, so a passing empty-store sweep proves the
  // toJudge === 0 short-circuit returns before any backend resolution.
  withoutJudgeConfig();
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  const exit = await runCli(["assess", "--all", "--judge-via", "api"]);
  expect(exit).toBe(0);
  // The sweep accounting, not the single-session judge (which would fail to
  // resolve a current session against an empty store).
  expect(stdout).toContain("matched 0");
  expect(stdout).toContain("to judge 0");
});

test("regimen assess --all --auto only considers conversations quiet for a full day", async () => {
  const dataDir = tempDataDir();
  process.env.REGIMEN_DATA_DIR = dataDir;
  withoutJudgeConfig();
  const store = openStore(join(dataDir, "feedback.db"));
  try {
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    store.db
      .prepare(
        `INSERT INTO conversations
           (session_id, harness, model, first_event_at, last_event_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "019e8c20-4491-7ea3-b809-d6586a5a72b8",
        "codex",
        "gpt-5",
        anHourAgo,
        anHourAgo,
      );
  } finally {
    store.close();
  }
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;

  const exit = await runCli([
    "assess",
    "--all",
    "--auto",
    "--judge-via",
    "api",
  ]);

  expect(exit).toBe(0);
  // Still active an hour ago, so quiescence excludes it entirely.
  expect(stdout).toContain("matched 0");
});
