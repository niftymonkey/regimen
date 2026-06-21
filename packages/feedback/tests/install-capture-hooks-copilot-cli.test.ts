/**
 * The wire-hooks / unwire-hooks CLI seam for Copilot (`versioned-command-leaves`),
 * driven in-process through `runCli`. The codex (nested) seam is covered by
 * install-capture-hooks-cli.test.ts; this suite proves the same commands write and
 * strip Copilot's on-disk shape: `<COPILOT_HOME>/hooks/hooks.json` holding
 * `{ version, hooks: { <event>: [flat leaf] } }`. Each test runs inside an isolated
 * env (temp HOME, temp COPILOT_HOME, temp REGIMEN_DATA_DIR) with stdout/stderr
 * captured by patching the write streams; afterEach restores both.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import { harnessDescriptor } from "../src/harness/descriptor.ts";

const DESCRIPTOR = harnessDescriptor("copilot");
if (DESCRIPTOR === undefined) {
  throw new Error("no copilot descriptor registered");
}
const CAPTURE_EVENTS = DESCRIPTOR.capture.events;

const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];
const MANAGED_ENV = [
  ...HARNESS_MARKERS,
  "COPILOT_HOME",
  "HOME",
  "REGIMEN_DATA_DIR",
];

interface Leaf {
  type: string;
  command: string;
  _regimen?: { v: number; role: string; id?: string };
}

let home: string;
let copilotHome: string;
let dataDir: string;
let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "regimen-copilot-home-"));
  copilotHome = mkdtempSync(join(tmpdir(), "regimen-copilot-cfg-"));
  dataDir = mkdtempSync(join(tmpdir(), "regimen-copilot-data-"));

  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];

  for (const marker of HARNESS_MARKERS) delete process.env[marker];
  process.env.REGIMEN_HARNESS = "copilot";
  process.env.HOME = home;
  process.env.COPILOT_HOME = copilotHome;
  process.env.REGIMEN_DATA_DIR = dataDir;

  savedStdoutWrite = process.stdout.write.bind(process.stdout);
  savedStderrWrite = process.stderr.write.bind(process.stderr);
});

afterEach(() => {
  process.stdout.write = savedStdoutWrite;
  process.stderr.write = savedStderrWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, copilotHome, dataDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface CliRun {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(...args: string[]): Promise<CliRun> {
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
  const exit = await runCli(["bun", "feedback", ...args]);
  return { exit, stdout, stderr };
}

const hooksPath = (): string =>
  join(copilotHome, DESCRIPTOR.contract.hooksFile.relativePath);

function readHooks(): {
  version?: number;
  hooks?: Record<string, Leaf[]>;
} {
  return JSON.parse(readFileSync(hooksPath(), "utf8"));
}

test("wire-hooks writes the versioned shape: version 1 and a flat capture leaf per event", async () => {
  const { exit } = await runCommand("wire-hooks");
  expect(exit).toBe(0);

  const parsed = readHooks();
  expect(parsed.version).toBe(1);
  for (const event of CAPTURE_EVENTS) {
    const leaves = parsed.hooks?.[event] ?? [];
    // Flat leaf array, exactly one capture leaf, no matcher-group wrapper.
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?._regimen?.role).toBe("capture");
    expect(leaves[0]?.type).toBe("command");
  }
});

test("wire-hooks is idempotent on re-run; no duplicate capture leaves", async () => {
  await runCommand("wire-hooks");
  const second = await runCommand("wire-hooks");
  expect(second.exit).toBe(0);
  expect(second.stdout).toContain("already wired");

  const parsed = readHooks();
  for (const event of CAPTURE_EVENTS) {
    const captures = (parsed.hooks?.[event] ?? []).filter(
      (l) => l._regimen?.role === "capture",
    );
    expect(captures).toHaveLength(1);
  }
});

test("wire-hooks preserves a foreign gate leaf and a user leaf; unwire strips only capture", async () => {
  const gateLeaf: Leaf = {
    type: "command",
    command: "bun /opt/regimen-enforcement/gates/rm-rf.ts",
    _regimen: { v: 1, role: "gate", id: "rm-rf" },
  };
  const userLeaf: Leaf = {
    type: "command",
    command: "bun /home/me/my-own-hook.ts",
  };
  // Copilot's hooks file lives under a `hooks/` subdir; create it before seeding.
  mkdirSync(dirname(hooksPath()), { recursive: true });
  writeFileSync(
    hooksPath(),
    JSON.stringify({
      version: 1,
      hooks: { preToolUse: [gateLeaf], postToolUse: [userLeaf] },
    }),
  );

  await runCommand("wire-hooks");
  const wired = readHooks();
  // Foreign + user leaves untouched, capture lands after each.
  expect(wired.hooks?.preToolUse?.[0]).toEqual(gateLeaf);
  expect(wired.hooks?.postToolUse?.[0]).toEqual(userLeaf);

  await runCommand("unwire-hooks");
  const after = readHooks();
  // Version preserved; only capture removed; foreign + user leaves remain.
  expect(after.version).toBe(1);
  expect(after.hooks?.preToolUse).toEqual([gateLeaf]);
  expect(after.hooks?.postToolUse).toEqual([userLeaf]);
  // Events Feedback created (capture-only) are pruned.
  expect(after.hooks?.sessionStart).toBeUndefined();
});
