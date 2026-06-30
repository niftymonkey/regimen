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
import { runCli } from "../src/cli/index.ts";

const MANAGED_ENV = [
  "REGIMEN_DATA_DIR",
  "REGIMEN_HARNESS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

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
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
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
