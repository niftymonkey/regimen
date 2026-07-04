/**
 * The `regimen calibrate` DISPATCH: argv routes to the read-only calibration
 * facade. Driven in-process through runCli against temp data and config dirs so
 * no host state is touched and no judge is resolved. The --help guard prints
 * usage without running, --save-golden persists the session list without a
 * judge, and a bare invocation with no reference set fails closed.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";

const MANAGED_ENV = [
  "REGIMEN_DATA_DIR",
  "REGIMEN_CONFIG_DIR",
  "REGIMEN_HARNESS",
];

let savedEnv: Record<string, string | undefined>;
let savedStdout: typeof process.stdout.write;
let savedStderr: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  savedStdout = process.stdout.write.bind(process.stdout);
  savedStderr = process.stderr.write.bind(process.stderr);
});

afterEach(() => {
  process.stdout.write = savedStdout;
  process.stderr.write = savedStderr;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function run(
  args: ReadonlyArray<string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  const exit = await runCli(args);
  return { exit, stdout, stderr };
}

test("regimen calibrate --help prints usage and runs nothing", async () => {
  const { exit, stdout } = await run(["calibrate", "--help"]);
  expect(exit).toBe(0);
  expect(stdout).toContain("usage: regimen calibrate");
  expect(stdout).toContain("--health");
});

test("regimen calibrate --save-golden persists the session list with no judge configured", async () => {
  const dataDir = tempDir("regimen-calibrate-data-");
  const configDir = tempDir("regimen-calibrate-config-");
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.REGIMEN_CONFIG_DIR = configDir;

  const { exit } = await run([
    "calibrate",
    "--save-golden",
    "--sessions",
    "aaa,bbb,ccc",
  ]);
  expect(exit).toBe(0);
  const golden = JSON.parse(
    readFileSync(join(configDir, "golden.json"), "utf8"),
  );
  expect(golden).toEqual([
    { sessionId: "aaa" },
    { sessionId: "bbb" },
    { sessionId: "ccc" },
  ]);
});

test("regimen calibrate with neither --sessions nor a golden set fails closed", async () => {
  const dataDir = tempDir("regimen-calibrate-data-");
  const configDir = tempDir("regimen-calibrate-config-");
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.REGIMEN_CONFIG_DIR = configDir;

  const { exit, stderr } = await run(["calibrate"]);
  expect(exit).toBe(1);
  expect(stderr).toContain("no sessions to calibrate");
});
