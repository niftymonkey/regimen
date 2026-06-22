/**
 * The Feedback CLI command FACADE: each subcommand is an exported library
 * function taking a typed, already-parsed options object, callable IN-PROCESS
 * without going through argv. This is the load-bearing surface the unified
 * `regimen` CLI imports and calls directly (ADR-0012): the dispatcher owns argv
 * parsing, these functions own the work.
 *
 * These tests call the command functions with options objects (never argv) and
 * assert the same exit-code / stdout / stderr contract the argv-driven path has.
 * They run inside an isolated env (temp HOME, temp REGIMEN_DATA_DIR) pinned in
 * `process.env`, with stdout/stderr captured by patching the write streams;
 * `afterEach` restores both env and streams so nothing leaks between tests.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnabled, setEnabled } from "../src/enabled-flag.ts";
import {
  assess,
  evidence,
  install,
  installDaemon,
  installSkill,
  list,
  purge,
  restart,
  start,
  status,
  stop,
  uninstall,
  uninstallDaemon,
  uninstallSkill,
  unwireHooks,
  wireHooks,
} from "../src/cli/index.ts";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { traceIdFor } from "@regimen/shared";
import { openStore } from "../src/store.ts";

const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];

const MANAGED_ENV = [
  ...HARNESS_MARKERS,
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "REGIMEN_DATA_DIR",
];

interface Captured {
  exit: number;
  stdout: string;
  stderr: string;
}

let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  for (const marker of HARNESS_MARKERS) delete process.env[marker];
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Capture stdout/stderr while running a command function in-process. The
 * function may return a number or a Promise<number>; awaiting handles both.
 */
async function capture(run: () => number | Promise<number>): Promise<Captured> {
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
  const exit = await run();
  return { exit, stdout, stderr };
}

test("start is callable in-process with an options object and enables capture", async () => {
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() =>
    start({ dataDir, dryRun: false }),
  );
  expect(exit).toBe(0);
  expect(isEnabled(dataDir)).toBe(true);
  expect(stdout).toContain("enabled");
});

test("stop is callable in-process with an options object and disables capture", async () => {
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  setEnabled(dataDir);
  const { exit, stdout } = await capture(() =>
    stop({ dataDir, dryRun: false }),
  );
  expect(exit).toBe(0);
  expect(isEnabled(dataDir)).toBe(false);
  expect(stdout).toContain("disabled");
});

test("restart is callable in-process with an options object and leaves capture enabled", async () => {
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  const { exit } = await capture(() => restart({ dataDir, dryRun: false }));
  expect(exit).toBe(0);
  expect(isEnabled(dataDir)).toBe(true);
});

test("status is callable in-process with an options object and reports state", async () => {
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() => status({ dataDir }));
  expect(exit).toBe(0);
  expect(stdout).toContain("feedback: disabled");
  expect(stdout).toContain("daemon: not running");
});

test("installDaemon is callable in-process with an options object under dry-run", async () => {
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() =>
    installDaemon({ dataDir, dryRun: true }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("would write");
});

test("uninstallDaemon is callable in-process with an options object under dry-run", async () => {
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() =>
    uninstallDaemon({ dataDir, dryRun: true }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("would remove");
});

test("purge is callable in-process with an options object and discards the buffer", async () => {
  const dataDir = tempDir("regimen-facade-");
  const bufferDir = join(dataDir, "buffer");
  mkdirSync(bufferDir, { recursive: true });
  writeFileSync(join(bufferDir, "current.jsonl"), "{}\n");
  const { exit, stdout } = await capture(() =>
    purge({ dataDir, all: false, force: false }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("buffer purged");
  expect(readdirSync(bufferDir)).toEqual([]);
});

test("purge --all is callable in-process with an options object and drops the store", async () => {
  const dataDir = tempDir("regimen-facade-");
  mkdirSync(join(dataDir, "buffer"), { recursive: true });
  const store = openStore(join(dataDir, "feedback.db"));
  store.close();
  const { exit, stdout } = await capture(() =>
    purge({ dataDir, all: true, force: false }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("store purged");
  expect(existsSync(join(dataDir, "feedback.db"))).toBe(false);
});

test("evidence is callable in-process with an explicit session and prints its digest", async () => {
  const dataDir = tempDir("regimen-facade-");
  const store = openStore(join(dataDir, "feedback.db"));
  store.insertEvent({
    schema_version: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    session_id: "facade-evidence",
    harness: "claude",
    event_type: "session.start",
    trace_id: traceIdFor("facade-evidence"),
    span_phase: "start",
    span_name: "session",
    attributes: {},
  });
  store.close();
  const { exit, stdout } = await capture(() =>
    evidence({ dataDir, session: "facade-evidence" }),
  );
  expect(exit).toBe(0);
  const digest = JSON.parse(stdout);
  expect(digest.known).toBe(true);
  expect(digest.sessionId).toBe("facade-evidence");
});

test("assess is callable in-process and fails closed on an unregistered harness", async () => {
  const dataDir = tempDir("regimen-facade-");
  process.env.REGIMEN_HARNESS = "cursor";
  const { exit, stderr } = await capture(() => assess({ dataDir }));
  expect(exit).toBe(1);
  expect(stderr).toContain("unsupported harness");
});

test("list is callable in-process with an options object and renders sessions", async () => {
  const dataDir = tempDir("regimen-facade-");
  const store = openStore(join(dataDir, "feedback.db"));
  store.insertEvent({
    schema_version: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    session_id: "facade-list",
    harness: "claude",
    event_type: "session.start",
    trace_id: traceIdFor("facade-list"),
    span_phase: "start",
    span_name: "session",
    attributes: {},
  });
  store.close();
  const { exit, stdout } = await capture(() =>
    list({ dataDir, filter: {}, asJson: false }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("1 session");
  expect(stdout).toContain("claude");
});

test("list under --json renders the SessionSummary array", async () => {
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() =>
    list({ dataDir, filter: {}, asJson: true }),
  );
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual([]);
});

test("installSkill is callable in-process with an options object under dry-run", async () => {
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = tempDir("regimen-facade-codex-");
  const { exit, stdout } = await capture(() => installSkill({ dryRun: true }));
  expect(exit).toBe(0);
  expect(stdout).toContain("would write");
});

test("uninstallSkill is callable in-process with an options object under dry-run", async () => {
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = tempDir("regimen-facade-codex-");
  const { exit, stdout } = await capture(() =>
    uninstallSkill({ dryRun: true }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("would remove");
});

test("wireHooks is callable in-process with an options object under dry-run", async () => {
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = tempDir("regimen-facade-codex-");
  const { exit, stdout } = await capture(() => wireHooks({ dryRun: true }));
  expect(exit).toBe(0);
  expect(stdout).toContain("would wire");
});

test("unwireHooks is callable in-process with an options object under dry-run", async () => {
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = tempDir("regimen-facade-codex-");
  const { exit, stdout } = await capture(() => unwireHooks({ dryRun: true }));
  expect(exit).toBe(0);
  expect(stdout).toContain("nothing to remove");
});

test("install is callable in-process with an options object under dry-run", async () => {
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = tempDir("regimen-facade-codex-");
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() =>
    install({ dataDir, dryRun: true }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("dry run complete");
  expect(isEnabled(dataDir)).toBe(false);
});

test("uninstall is callable in-process with an options object under dry-run", async () => {
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = tempDir("regimen-facade-codex-");
  process.env.HOME = tempDir("regimen-facade-home-");
  const dataDir = tempDir("regimen-facade-");
  const { exit, stdout } = await capture(() =>
    uninstall({ dataDir, dryRun: true }),
  );
  expect(exit).toBe(0);
  expect(stdout).toContain("dry run complete");
});
