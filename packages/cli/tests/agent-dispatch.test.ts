/**
 * The tier C agent-path DISPATCH in `regimen assess`. `--judge-via agent` names a
 * two-step flow (emit the prompt, record the verdict) rather than an in-process
 * backend, so used directly it prints that usage on stderr and exits 2, distinct
 * from a recorded/emitted judgment (0) and a recorder rejection (1). The two
 * flags route to the emit and record facades rather than the paid single-session
 * judge. Driven in-process through runCli against a temp data dir.
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
];

let savedEnv: Record<string, string | undefined>;
let savedStdout: typeof process.stdout.write;
let savedStderr: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  delete process.env.REGIMEN_HARNESS;
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

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-agent-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

async function run(argv: string[]): Promise<{ exit: number; stderr: string }> {
  let stderr = "";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  const exit = await runCli(argv);
  return { exit, stderr };
}

test("regimen assess --judge-via agent exits 2 and prints the emit/record usage", async () => {
  process.env.REGIMEN_DATA_DIR = tempDataDir();
  const { exit, stderr } = await run(["assess", "--judge-via", "agent"]);
  expect(exit).toBe(2);
  expect(stderr).toContain("--emit-prompt");
  expect(stderr).toContain("--record-verdict");
});
