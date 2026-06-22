/**
 * The Feedback `install` facade run with the daemon step skipped (the
 * `--no-daemon` path the unified CLI threads through as `daemon: false`). A
 * non-admin corporate Windows account is blocked from creating scheduled tasks,
 * so the loader daemon cannot be installed; this option lets capture wiring
 * (hooks + skills + enable) complete anyway, with the user draining the buffer
 * by hand. Driven IN-PROCESS through the exported `install` facade against a
 * temp HOME and data dir, with `selfLink: false` so the test never runs a real
 * `bun link`, and the harness pinned to Claude so the hooks land in
 * `<HOME>/.claude/settings.json` and the skills under `<HOME>/.claude/skills`.
 *
 * The systemd-unit assertion is Linux-specific (the macOS and Windows service
 * paths differ); the test early-returns on other platforms, where the
 * cross-platform behavior is the same skip with a different service path.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../src/cli/index.ts";

const MANAGED_ENV = ["HOME", "REGIMEN_DATA_DIR", "REGIMEN_HARNESS"];

let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
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
 * Pin a temp HOME, data dir, and the Claude harness, capture stdout, then run
 * the real `install` facade with the daemon skipped and the self-link off.
 */
function runNoDaemonInstall(): { exit: number; home: string; stdout: string } {
  const home = tempDir("regimen-nodaemon-home-");
  const dataDir = tempDir("regimen-nodaemon-data-");
  process.env.HOME = home;
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.REGIMEN_HARNESS = "claude";
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  const exit = install({
    dataDir,
    dryRun: false,
    selfLink: false,
    daemon: false,
  });
  return { exit, home, stdout };
}

test("install with the daemon skipped writes no systemd service file", () => {
  if (process.platform !== "linux") return;
  const { exit, home } = runNoDaemonInstall();
  expect(exit).toBe(0);
  const unitPath = join(
    home,
    ".config",
    "systemd",
    "user",
    "regimen-feedback.service",
  );
  expect(existsSync(unitPath)).toBe(false);
});

test("install with the daemon skipped prints how to drain the buffer by hand", () => {
  if (process.platform !== "linux") return;
  const { exit, stdout } = runNoDaemonInstall();
  expect(exit).toBe(0);
  expect(stdout).toContain("daemon skipped (--no-daemon)");
  expect(stdout).toContain("the loader is not running");
  expect(stdout).toContain("bun packages/feedback/src/loader/run.ts");
  expect(stdout).not.toContain("confirm the daemon is live");
});

test("install with the daemon skipped still wires the capture hooks and installs the skills", () => {
  if (process.platform !== "linux") return;
  const { exit, home } = runNoDaemonInstall();
  expect(exit).toBe(0);
  expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
  expect(
    existsSync(
      join(home, ".claude", "skills", "feedback-evidence", "SKILL.md"),
    ),
  ).toBe(true);
});

test("a dry-run install with the daemon skipped omits the daemon preview and notes the skip", () => {
  if (process.platform !== "linux") return;
  const home = tempDir("regimen-nodaemon-home-");
  const dataDir = tempDir("regimen-nodaemon-data-");
  process.env.HOME = home;
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.REGIMEN_HARNESS = "claude";
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  const exit = install({
    dataDir,
    dryRun: true,
    selfLink: false,
    daemon: false,
  });
  expect(exit).toBe(0);
  expect(stdout).toContain("daemon skipped (--no-daemon)");
  expect(stdout).not.toContain("regimen-feedback.service");
  expect(stdout).not.toContain("systemctl");
});
