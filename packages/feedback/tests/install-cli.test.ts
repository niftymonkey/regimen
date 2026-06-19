/**
 * The CLI's install-daemon and uninstall-daemon commands exercised in
 * --dry-run mode against a temp HOME and data dir, so the supervisor on
 * the test host is never touched. The assertions are Linux-specific
 * (systemd unit, systemctl) and the tests early-return on other platforms;
 * the macOS and Windows planners are covered by their own unit tests.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

async function runCli(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exit: await proc.exited, stdout, stderr };
}

function withTempHomeAndDataDir(
  fn: (home: string, dataDir: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "regimen-install-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-install-data-"));
  return fn(home, dataDir).finally(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
}

test("install-daemon --dry-run on Linux reports the unit path and planned systemctl commands without writing or running anything", async () => {
  if (process.platform !== "linux") return;
  await withTempHomeAndDataDir(async (home, dataDir) => {
    const { exit, stdout } = await runCli(["install-daemon", "--dry-run"], {
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
    const { exit, stdout } = await runCli(["uninstall-daemon", "--dry-run"], {
      HOME: home,
      REGIMEN_DATA_DIR: dataDir,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain(
      "would run: systemctl --user disable --now regimen-feedback.service",
    );
    expect(stdout).toContain("would remove");
    expect(stdout).toContain("regimen-feedback.service");
  });
});
