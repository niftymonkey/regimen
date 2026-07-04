/**
 * The `regimen rollup` DISPATCH: argv routes to the feedback rollup facade as a
 * READ over the persisted verdicts, not the write sweep. Driven in-process
 * through runCli against a temp data dir with an empty store, so no real verdict
 * is synthesized and the host store is never touched. No judge backend is
 * configured (the key is deleted, and `--judge-via api` forces the HTTP backend
 * so resolving a judge would throw): an empty-store rollup must still succeed,
 * which proves it short-circuits on the empty slice BEFORE backend resolution
 * rather than relying on a configured judge. The filter flags reach the facade,
 * asserted through the echoed `filter` in the --json output.
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
  const dir = mkdtempSync(join(tmpdir(), "regimen-rollup-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

async function run(args: ReadonlyArray<string>): Promise<string> {
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  const exit = await runCli(args);
  expect(exit).toBe(0);
  return stdout;
}

test("regimen rollup routes to the read facade and reports an empty slice without a judge", async () => {
  const dataDir = tempDataDir();
  process.env.REGIMEN_DATA_DIR = dataDir;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  const stdout = await run(["rollup", "--judge-via", "api", "--json"]);
  const parsed = JSON.parse(stdout);
  expect(parsed.header.totalJudged).toBe(0);
  expect(parsed.synthesis).toBeNull();
});

test("regimen rollup threads the list filter flags to the facade", async () => {
  const dataDir = tempDataDir();
  process.env.REGIMEN_DATA_DIR = dataDir;
  delete process.env.ANTHROPIC_API_KEY;
  const stdout = await run([
    "rollup",
    "--harness",
    "gemini",
    "--since",
    "7d",
    "--json",
  ]);
  const parsed = JSON.parse(stdout);
  expect(parsed.filter).toEqual({ harness: "gemini", since: "7d" });
});
