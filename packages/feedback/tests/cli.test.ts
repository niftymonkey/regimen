/**
 * Feedback CLI behavior. Each test spawns the CLI as a subprocess so the
 * argv parsing, env handling, exit codes, and stdout are all exercised the
 * same way an engineer's shell would exercise them.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionStamp } from "../src/codex/session-stamp.ts";
import { traceIdFor } from "@regimen/shared";
import { isEnabled, setEnabled } from "../src/enabled-flag.ts";
import { openStore } from "../src/store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI against a data dir, pinning HOME to an isolated temp directory.
 *
 * The lifecycle commands resolve "is a service installed here" from HOME (the
 * systemd unit and the launchd plist live under it). Inheriting the real HOME
 * would let a test discover the maintainer's real `regimen-feedback.service`
 * and drive its supervisor, so every CLI test gets a throwaway HOME with no
 * service installed; the supervised branch is exercised only through explicit
 * fake markers under that HOME plus `--dry-run`.
 */
async function runCli(
  args: ReadonlyArray<string>,
  dataDir: string,
): Promise<CliResult> {
  const home = mkdtempSync(join(tmpdir(), "regimen-cli-home-"));
  try {
    return await runCliWith(args, { REGIMEN_DATA_DIR: dataDir, HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Spawn the CLI with explicit env overrides and an optional working dir. */
async function runCliWith(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  cwd?: string,
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exit: await proc.exited, stdout, stderr };
}

function withDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-cli-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/**
 * Provide an isolated data dir plus an isolated HOME, and a `seedService`
 * callback that writes the platform's service-definition file under that HOME
 * so the lifecycle commands take the supervised branch. The supervised tests
 * pair this with `--dry-run` so the real supervisor is never invoked.
 */
function withDataDirAndHome(
  fn: (ctx: {
    dataDir: string;
    home: string;
    run: (args: ReadonlyArray<string>) => Promise<CliResult>;
    seedService: () => void;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-cli-"));
  const home = mkdtempSync(join(tmpdir(), "regimen-cli-home-"));
  const run = (args: ReadonlyArray<string>): Promise<CliResult> =>
    runCliWith(args, { REGIMEN_DATA_DIR: dataDir, HOME: home });
  const seedService = (): void => {
    if (process.platform === "linux") {
      const unitDir = join(home, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, "regimen-feedback.service"), "[Service]\n");
      return;
    }
    if (process.platform === "darwin") {
      const agentDir = join(home, "Library", "LaunchAgents");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "dev.niftymonkey.regimen-feedback.plist"),
        "<plist/>\n",
      );
      return;
    }
    // win32: the task XML lives under the data dir, not HOME.
    writeFileSync(join(dataDir, "regimen-feedback.task.xml"), "<Task/>\n");
  };
  return fn({ dataDir, home, run, seedService }).finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

test("feedback start creates the enabled flag and reports success", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runCli(["start"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("enabled");
  });
});

test("feedback start without an installed service says no daemon was launched and how to run one", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runCli(["start"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    // Honest: nothing in the output may imply a daemon is now running.
    expect(stdout).toContain("no daemon");
    expect(stdout).toMatch(/install-daemon|run\.ts/);
    expect(stdout).not.toMatch(/daemon (started|running)/);
  });
});

test("feedback start is idempotent and reports the already-enabled state", async () => {
  await withDataDir(async (dataDir) => {
    await runCli(["start"], dataDir);
    const second = await runCli(["start"], dataDir);
    expect(second.exit).toBe(0);
    expect(second.stdout).toContain("already enabled");
    expect(isEnabled(dataDir)).toBe(true);
  });
});

test("feedback stop removes the enabled flag", async () => {
  await withDataDir(async (dataDir) => {
    await runCli(["start"], dataDir);
    expect(isEnabled(dataDir)).toBe(true);
    const { exit, stdout } = await runCli(["stop"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).toContain("disabled");
  });
});

test("feedback stop is idempotent and reports the already-disabled state", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runCli(["stop"], dataDir);
    expect(exit).toBe(0);
    expect(stdout).toContain("already disabled");
  });
});

test("feedback stop without an installed service explains the manual daemon self-exits on the poll cadence", async () => {
  await withDataDir(async (dataDir) => {
    await runCli(["start"], dataDir);
    const { exit, stdout } = await runCli(["stop"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).toContain("disabled");
    expect(stdout).toContain("self-exit");
  });
});

test("feedback restart leaves the flag enabled regardless of starting state", async () => {
  await withDataDir(async (dataDir) => {
    const { exit } = await runCli(["restart"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);

    const second = await runCli(["restart"], dataDir);
    expect(second.exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
  });
});

test("feedback restart fails loudly when an unsupervised daemon is alive instead of pretending to cycle it", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    // A live pid with no installed service: the old clear-then-set window was
    // too brief for the loader's flag poll, so the daemon never cycled while
    // the CLI printed success. Restart cannot relaunch a manual daemon, so it
    // must fail loudly rather than report a restart that did not happen.
    writeFileSync(join(dataDir, "daemon.pid"), `${process.pid}\n`);
    const { exit, stderr, stdout } = await runCli(["restart"], dataDir);
    expect(exit).not.toBe(0);
    expect(stderr).toContain("cannot be restarted");
    expect(stderr).toContain(String(process.pid));
    expect(stdout).not.toContain("restarted");
  });
});

test("feedback start --dry-run previews the supervisor start command and leaves the enabled flag untouched", async () => {
  await withDataDirAndHome(async ({ dataDir, run, seedService }) => {
    seedService();
    const { exit, stdout } = await run(["start", "--dry-run"]);
    expect(exit).toBe(0);
    // A dry-run changes nothing: the capture-and-storage gate (ADR-0006) is
    // not flipped by a preview.
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).toContain("would run:");
    // A dry-run never claims the supervisor acted; only "would run" previews.
    expect(stdout).not.toContain("daemon started via the supervisor");
    if (process.platform === "linux") {
      expect(stdout).toContain(
        "would run: systemctl --user start regimen-feedback.service",
      );
    } else if (process.platform === "darwin") {
      expect(stdout).toContain(
        "would run: launchctl start dev.niftymonkey.regimen-feedback",
      );
    } else {
      expect(stdout).toContain("would run: schtasks /Run /TN regimen-feedback");
    }
  });
});

test("feedback stop --dry-run previews the supervisor stop command and leaves the enabled flag untouched", async () => {
  await withDataDirAndHome(async ({ dataDir, run, seedService }) => {
    seedService();
    setEnabled(dataDir);
    const { exit, stdout } = await run(["stop", "--dry-run"]);
    expect(exit).toBe(0);
    // A dry-run changes nothing: a preview must not stop capture (ADR-0006).
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("would run:");
    expect(stdout).not.toContain("daemon stopped via the supervisor");
    if (process.platform === "linux") {
      expect(stdout).toContain(
        "would run: systemctl --user stop regimen-feedback.service",
      );
    } else if (process.platform === "darwin") {
      expect(stdout).toContain(
        "would run: launchctl stop dev.niftymonkey.regimen-feedback",
      );
    } else {
      expect(stdout).toContain("would run: schtasks /End /TN regimen-feedback");
    }
  });
});

test("feedback restart --dry-run previews the supervisor restart command and leaves the enabled flag untouched", async () => {
  await withDataDirAndHome(async ({ dataDir, run, seedService }) => {
    seedService();
    const { exit, stdout } = await run(["restart", "--dry-run"]);
    expect(exit).toBe(0);
    // A dry-run changes nothing: a preview must not enable capture (ADR-0006).
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).not.toContain("daemon cycled via the supervisor");
    if (process.platform === "linux") {
      expect(stdout).toContain(
        "would run: systemctl --user restart regimen-feedback.service",
      );
    } else if (process.platform === "darwin") {
      expect(stdout).toContain("would run: launchctl kickstart -k gui/");
    } else {
      expect(stdout).toContain("would run: schtasks /End /TN regimen-feedback");
      expect(stdout).toContain("would run: schtasks /Run /TN regimen-feedback");
    }
  });
});

test("feedback start --dry-run with no service installed previews without enabling capture", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runCli(["start", "--dry-run"], dataDir);
    expect(exit).toBe(0);
    // The preview must not flip the capture gate (ADR-0006), and the output
    // must not claim an enable that did not happen.
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).toContain("would enable feedback");
    expect(stdout).not.toContain("feedback enabled");
  });
});

test("feedback stop --dry-run with no service installed previews without stopping capture", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const { exit, stdout } = await runCli(["stop", "--dry-run"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("would disable feedback");
    expect(stdout).not.toContain("feedback disabled");
  });
});

test("feedback restart --dry-run with no service installed reports an already-enabled flag rather than claiming it would enable", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const { exit, stdout } = await runCli(["restart", "--dry-run"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("already enabled");
    expect(stdout).not.toContain("would enable");
  });
});

test("an unknown command exits 1 with an error on stderr", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stderr } = await runCli(["bogus"], dataDir);
    expect(exit).toBe(1);
    expect(stderr).toContain("unknown command");
  });
});

test("feedback status reports disabled when the flag is absent and no daemon is running", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runCli(["status"], dataDir);
    expect(exit).toBe(0);
    expect(stdout).toContain("feedback: disabled");
    expect(stdout).toContain("daemon: not running");
    expect(stdout).toContain("last event: never");
    expect(stdout).toContain("backlog: 0 bytes");
  });
});

function seedBuffer(dataDir: string): string {
  const bufferDir = join(dataDir, "buffer");
  mkdirSync(bufferDir, { recursive: true });
  writeFileSync(join(bufferDir, "current.jsonl"), "{}\n");
  writeFileSync(
    join(bufferDir, "sealed-2026-05-21T17-00-00-000Z.jsonl"),
    "{}\n",
  );
  return bufferDir;
}

test("feedback purge discards the buffer segments but keeps the store and logs", async () => {
  await withDataDir(async (dataDir) => {
    const bufferDir = seedBuffer(dataDir);
    const store = openStore(join(dataDir, "feedback.db"));
    store.close();
    writeFileSync(join(dataDir, "daemon.log"), "started\n");

    const { exit, stdout } = await runCli(["purge"], dataDir);

    expect(exit).toBe(0);
    expect(stdout).toContain("buffer purged");
    expect(readdirSync(bufferDir)).toEqual([]);
    expect(existsSync(join(dataDir, "feedback.db"))).toBe(true);
    expect(existsSync(join(dataDir, "daemon.log"))).toBe(true);
  });
});

test("feedback purge --all also drops the SQLite store and the daemon logs", async () => {
  await withDataDir(async (dataDir) => {
    const bufferDir = seedBuffer(dataDir);
    const store = openStore(join(dataDir, "feedback.db"));
    store.close();
    writeFileSync(join(dataDir, "daemon.log"), "started\n");
    writeFileSync(join(dataDir, "daemon.log.1"), "older\n");
    writeFileSync(join(dataDir, "capture-errors.log"), "boom\n");
    expect(existsSync(join(dataDir, "feedback.db"))).toBe(true);

    const { exit, stdout } = await runCli(["purge", "--all"], dataDir);

    expect(exit).toBe(0);
    expect(stdout).toContain("store purged");
    expect(stdout).toContain("logs purged");
    expect(readdirSync(bufferDir)).toEqual([]);
    expect(existsSync(join(dataDir, "feedback.db"))).toBe(false);
    expect(existsSync(join(dataDir, "daemon.log"))).toBe(false);
    expect(existsSync(join(dataDir, "daemon.log.1"))).toBe(false);
    expect(existsSync(join(dataDir, "capture-errors.log"))).toBe(false);
  });
});

test("feedback purge refuses to run while the daemon is alive", async () => {
  await withDataDir(async (dataDir) => {
    const bufferDir = seedBuffer(dataDir);
    writeFileSync(join(dataDir, "daemon.pid"), `${process.pid}\n`);

    const { exit, stderr } = await runCli(["purge"], dataDir);

    expect(exit).toBe(1);
    expect(stderr).toContain("daemon is running");
    expect(stderr).toContain(String(process.pid));
    expect(readdirSync(bufferDir).sort()).toEqual([
      "current.jsonl",
      "sealed-2026-05-21T17-00-00-000Z.jsonl",
    ]);
  });
});

test("feedback purge --force purges despite a running daemon", async () => {
  await withDataDir(async (dataDir) => {
    const bufferDir = seedBuffer(dataDir);
    writeFileSync(join(dataDir, "daemon.pid"), `${process.pid}\n`);

    const { exit, stdout } = await runCli(["purge", "--force"], dataDir);

    expect(exit).toBe(0);
    expect(stdout).toContain("buffer purged");
    expect(readdirSync(bufferDir)).toEqual([]);
  });
});

test("feedback evidence prints the digest JSON for a seeded session", async () => {
  await withDataDir(async (dataDir) => {
    const store = openStore(join(dataDir, "feedback.db"));
    store.insertEvent({
      schema_version: 1,
      timestamp: "2026-05-21T12:00:00.000Z",
      session_id: "cli-evidence",
      harness: "claude",
      event_type: "session.start",
      trace_id: traceIdFor("cli-evidence"),
      span_phase: "start",
      span_name: "session",
      attributes: {},
    });
    store.close();

    const { exit, stdout } = await runCli(
      ["evidence", "--session", "cli-evidence"],
      dataDir,
    );

    expect(exit).toBe(0);
    const digest = JSON.parse(stdout);
    expect(digest.known).toBe(true);
    expect(digest.sessionId).toBe("cli-evidence");
    expect(digest.schemaVersion).toBe(1);
  });
});

test("feedback evidence with no store file exits 0 with a known:false digest", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runCli(
      ["evidence", "--session", "ghost"],
      dataDir,
    );
    expect(exit).toBe(0);
    const digest = JSON.parse(stdout);
    expect(digest.known).toBe(false);
    expect(digest.sessionId).toBe("ghost");
  });
});

test("feedback evidence resolves the current session for the env-detected harness and prints its digest", async () => {
  await withDataDir(async (dataDir) => {
    const cwd = mkdtempSync(join(tmpdir(), "regimen-codex-cwd-"));
    const codexHome = mkdtempSync(join(tmpdir(), "regimen-codex-home-"));
    try {
      writeSessionStamp({
        dataDir,
        harness: "codex",
        cwd,
        sessionId: "resolved-sess",
      });
      const store = openStore(join(dataDir, "feedback.db"));
      store.insertEvent({
        schema_version: 1,
        timestamp: "2026-06-03T12:00:00.000Z",
        session_id: "resolved-sess",
        harness: "codex",
        event_type: "session.start",
        trace_id: traceIdFor("resolved-sess"),
        span_phase: "start",
        span_name: "session",
        attributes: {},
      });
      store.close();

      const { exit, stdout } = await runCliWith(
        ["evidence"],
        {
          REGIMEN_DATA_DIR: dataDir,
          REGIMEN_HARNESS: "codex",
          CODEX_HOME: codexHome,
        },
        cwd,
      );

      expect(exit).toBe(0);
      const digest = JSON.parse(stdout);
      expect(digest.known).toBe(true);
      expect(digest.sessionId).toBe("resolved-sess");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

test("feedback evidence with nothing to resolve prints an unknown digest", async () => {
  await withDataDir(async (dataDir) => {
    const cwd = mkdtempSync(join(tmpdir(), "regimen-codex-cwd-"));
    const codexHome = mkdtempSync(join(tmpdir(), "regimen-codex-home-"));
    try {
      const { exit, stdout } = await runCliWith(
        ["evidence"],
        {
          REGIMEN_DATA_DIR: dataDir,
          REGIMEN_HARNESS: "codex",
          CODEX_HOME: codexHome,
        },
        cwd,
      );

      expect(exit).toBe(0);
      const digest = JSON.parse(stdout);
      expect(digest.known).toBe(false);
      expect(digest.note).toContain("resolve");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

test("feedback evidence fails closed when REGIMEN_HARNESS names an unregistered harness", async () => {
  await withDataDir(async (dataDir) => {
    const cwd = mkdtempSync(join(tmpdir(), "regimen-evidence-cwd-"));
    try {
      const { exit, stdout, stderr } = await runCliWith(
        ["evidence"],
        { REGIMEN_DATA_DIR: dataDir, REGIMEN_HARNESS: "gemini" },
        cwd,
      );
      expect(exit).not.toBe(0);
      expect(stderr).toContain("unsupported harness");
      expect(stdout).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("feedback evidence fails fast when no home and no CODEX_HOME are set", async () => {
  await withDataDir(async (dataDir) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.HOME;
    delete env.USERPROFILE;
    delete env.CODEX_HOME;
    env.REGIMEN_DATA_DIR = dataDir;
    env.REGIMEN_HARNESS = "codex";
    const proc = Bun.spawn(["bun", CLI, "evidence"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("HOME");
  });
});

test("feedback evidence fails closed when no harness can be resolved", async () => {
  await withDataDir(async (dataDir) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.CLAUDECODE;
    delete env.CODEX_THREAD_ID;
    delete env.GEMINI_CLI;
    delete env.COPILOT_CLI;
    delete env.REGIMEN_HARNESS;
    env.REGIMEN_DATA_DIR = dataDir;
    const proc = Bun.spawn(["bun", CLI, "evidence"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("could not determine the harness");
  });
});

test("feedback status reports the last event timestamp and the buffer backlog", async () => {
  await withDataDir(async (dataDir) => {
    const store = openStore(join(dataDir, "feedback.db"));
    store.insertEvent({
      schema_version: 1,
      timestamp: "2026-05-21T12:00:00.000Z",
      session_id: "status-test",
      harness: "claude",
      event_type: "session.start",
      trace_id: traceIdFor("status-test"),
      span_phase: "start",
      span_name: "session",
      attributes: {},
    });
    store.close();

    mkdirSync(join(dataDir, "buffer"), { recursive: true });
    writeFileSync(join(dataDir, "buffer", "current.jsonl"), "x".repeat(1024));

    setEnabled(dataDir);
    const { exit, stdout } = await runCli(["status"], dataDir);
    expect(exit).toBe(0);
    expect(stdout).toContain("feedback: enabled");
    expect(stdout).toContain("2026-05-21T12:00:00.000Z");
    expect(stdout).toContain("1024");
  });
});
