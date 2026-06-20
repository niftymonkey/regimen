/**
 * The CLI's install-daemon and uninstall-daemon commands exercised in
 * --dry-run mode against a temp HOME and data dir, so the supervisor on the test
 * host is never touched. Driven IN-PROCESS through the exported `runCli` entry
 * point rather than by spawning a `bun` subprocess per assertion (the cold-start
 * raced this suite's per-test timeout under load). The assertions are
 * Linux-specific (systemd unit, systemctl) and the tests early-return on other
 * platforms; the macOS and Windows planners are covered by their own unit tests.
 *
 * Each test pins HOME and REGIMEN_DATA_DIR to throwaway temp dirs in
 * `process.env` and captures stdout/stderr by patching the write streams;
 * `afterEach` restores both the env and the streams so the in-process driving
 * leaves no global state behind.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";

/** The env keys this suite pins, captured and restored per test. */
const MANAGED_ENV = ["HOME", "REGIMEN_DATA_DIR"];

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

/** Pin env overrides for one call, then drive runCli in-process. */
async function runCliWith(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
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

function withTempHomeAndDataDir(
  fn: (home: string, dataDir: string) => Promise<void>,
): Promise<void> {
  return fn(tempDir("regimen-install-home-"), tempDir("regimen-install-data-"));
}

test("install-daemon --dry-run on Linux reports the unit path and planned systemctl commands without writing or running anything", async () => {
  if (process.platform !== "linux") return;
  await withTempHomeAndDataDir(async (home, dataDir) => {
    const { exit, stdout } = await runCliWith(["install-daemon", "--dry-run"], {
      HOME: home,
      REGIMEN_DATA_DIR: dataDir,
    });
    expect(exit).toBe(0);

    const unitPath = join(
      home,
      ".config",
      "systemd",
      "user",
      "regimen-feedback.service",
    );
    expect(existsSync(unitPath)).toBe(false);

    expect(stdout).toContain(`would write ${unitPath}`);
    expect(stdout).toContain("would run: systemctl --user daemon-reload");
    expect(stdout).toContain(
      "would run: systemctl --user enable --now regimen-feedback.service",
    );
  });
});

test("uninstall-daemon --dry-run on Linux reports the planned systemctl commands and would-remove path", async () => {
  if (process.platform !== "linux") return;
  await withTempHomeAndDataDir(async (home, dataDir) => {
    const { exit, stdout } = await runCliWith(
      ["uninstall-daemon", "--dry-run"],
      {
        HOME: home,
        REGIMEN_DATA_DIR: dataDir,
      },
    );
    expect(exit).toBe(0);
    expect(stdout).toContain(
      "would run: systemctl --user disable --now regimen-feedback.service",
    );
    expect(stdout).toContain("would remove");
    expect(stdout).toContain("regimen-feedback.service");
  });
});
