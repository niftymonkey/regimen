/**
 * Feedback CLI behavior, driven IN-PROCESS through the exported `runCli` entry
 * point rather than by spawning a `bun` subprocess per assertion. The argv
 * parsing, env handling, exit codes, and stdout/stderr are all exercised the
 * same way an engineer's shell would exercise them, but without paying a bun
 * cold-start per test.
 *
 * Why in-process: each `Bun.spawn(["bun", CLI, ...])` paid a cold-start that
 * historically raced this suite's per-test timeout under the live capture
 * daemon's CPU load (a flake that hit repeatedly). Driving `runCli` directly
 * drops the per-test body to a few milliseconds and removes the flake. Each test
 * runs inside an isolated env (temp HOME, temp REGIMEN_DATA_DIR, temp
 * CODEX_HOME) pinned in `process.env`, with stdout/stderr captured by patching
 * `process.stdout.write` / `process.stderr.write`; `afterEach` restores both the
 * env and the write streams so the in-process driving leaves no global state
 * behind.
 *
 * The lifecycle commands resolve "is a service installed here" from HOME (the
 * systemd unit and the launchd plist live under it). A throwaway HOME with no
 * service installed keeps every test off the maintainer's real
 * `regimen-feedback.service`; the supervised branch is exercised only through an
 * explicit seeded service file under that HOME plus `--dry-run`, so the real
 * supervisor is never invoked.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { runCli } from "../src/cli/index.ts";

/**
 * The per-harness marker env vars the resolver falls back to when REGIMEN_HARNESS
 * is unset. The live machine running this suite can itself be inside one of these
 * harnesses (e.g. CLAUDECODE=1), so the fail-closed tests clear all of them (and
 * REGIMEN_HARNESS) to be hermetic rather than resolving the ambient harness.
 */
const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];

/** The env keys this suite pins or clears, captured and restored per test. */
const MANAGED_ENV = [
  ...HARNESS_MARKERS,
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "REGIMEN_DATA_DIR",
];

interface CliResult {
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
  // Clear every ambient harness marker so the suite is independent of whichever
  // harness CLI happens to be running it; each test pins what it needs.
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

/** A throwaway temp directory, auto-removed in `afterEach`. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Drive runCli for a single command in-process, capturing stdout and stderr.
 * argv mimics process.argv, so the command lands at index 2. runCli may return a
 * number or a Promise<number>; awaiting a number is a no-op, so this handles
 * both the synchronous lifecycle path and the async assess path uniformly.
 */
async function invoke(...args: string[]): Promise<CliResult> {
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

/**
 * Run the CLI against a data dir, pinning HOME to an isolated temp directory.
 * Inheriting the real HOME would let a test discover the maintainer's real
 * `regimen-feedback.service` and drive its supervisor, so every CLI test gets a
 * throwaway HOME with no service installed.
 */
async function runDir(
  args: ReadonlyArray<string>,
  dataDir: string,
): Promise<CliResult> {
  return runWith(args, {
    REGIMEN_DATA_DIR: dataDir,
    HOME: tempDir("regimen-cli-home-"),
  });
}

/** Pin explicit env overrides for one call, then drive runCli in-process. */
async function runWith(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<CliResult> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return invoke(...args);
}

function withDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  return fn(tempDir("regimen-cli-"));
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
  const dataDir = tempDir("regimen-cli-");
  const home = tempDir("regimen-cli-home-");
  const run = (args: ReadonlyArray<string>): Promise<CliResult> =>
    runWith(args, { REGIMEN_DATA_DIR: dataDir, HOME: home });
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
  return fn({ dataDir, home, run, seedService });
}

test("feedback start creates the enabled flag and reports success", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runDir(["start"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("enabled");
  });
});

test("feedback start without an installed service says no daemon was launched and how to run one", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runDir(["start"], dataDir);
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
    await runDir(["start"], dataDir);
    const second = await runDir(["start"], dataDir);
    expect(second.exit).toBe(0);
    expect(second.stdout).toContain("already enabled");
    expect(isEnabled(dataDir)).toBe(true);
  });
});

test("feedback stop removes the enabled flag", async () => {
  await withDataDir(async (dataDir) => {
    await runDir(["start"], dataDir);
    expect(isEnabled(dataDir)).toBe(true);
    const { exit, stdout } = await runDir(["stop"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).toContain("disabled");
  });
});

test("feedback stop is idempotent and reports the already-disabled state", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runDir(["stop"], dataDir);
    expect(exit).toBe(0);
    expect(stdout).toContain("already disabled");
  });
});

test("feedback stop without an installed service explains the manual daemon self-exits on the poll cadence", async () => {
  await withDataDir(async (dataDir) => {
    await runDir(["start"], dataDir);
    const { exit, stdout } = await runDir(["stop"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(false);
    expect(stdout).toContain("disabled");
    expect(stdout).toContain("self-exit");
  });
});

test("feedback restart leaves the flag enabled regardless of starting state", async () => {
  await withDataDir(async (dataDir) => {
    const { exit } = await runDir(["restart"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);

    const second = await runDir(["restart"], dataDir);
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
    const { exit, stderr, stdout } = await runDir(["restart"], dataDir);
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
    const { exit, stdout } = await runDir(["start", "--dry-run"], dataDir);
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
    const { exit, stdout } = await runDir(["stop", "--dry-run"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("would disable feedback");
    expect(stdout).not.toContain("feedback disabled");
  });
});

test("feedback restart --dry-run with no service installed reports an already-enabled flag rather than claiming it would enable", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const { exit, stdout } = await runDir(["restart", "--dry-run"], dataDir);
    expect(exit).toBe(0);
    expect(isEnabled(dataDir)).toBe(true);
    expect(stdout).toContain("already enabled");
    expect(stdout).not.toContain("would enable");
  });
});

test("an unknown command exits 1 with an error on stderr", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stderr } = await runDir(["bogus"], dataDir);
    expect(exit).toBe(1);
    expect(stderr).toContain("unknown command");
  });
});

test("feedback status reports disabled when the flag is absent and no daemon is running", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runDir(["status"], dataDir);
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

    const { exit, stdout } = await runDir(["purge"], dataDir);

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

    const { exit, stdout } = await runDir(["purge", "--all"], dataDir);

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

    const { exit, stderr } = await runDir(["purge"], dataDir);

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

    const { exit, stdout } = await runDir(["purge", "--force"], dataDir);

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

    const { exit, stdout } = await runDir(
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
    const { exit, stdout } = await runDir(
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
    const codexHome = tempDir("regimen-codex-home-");
    // The codex resolver keys the stamp by a hash of the cwd it is given; the
    // command resolves the current session from `process.cwd()`, so stamping
    // the live process cwd is what makes the producer and consumer agree
    // without forking the process working directory.
    const cwd = process.cwd();
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

    const { exit, stdout } = await runWith(["evidence"], {
      REGIMEN_DATA_DIR: dataDir,
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });

    expect(exit).toBe(0);
    const digest = JSON.parse(stdout);
    expect(digest.known).toBe(true);
    expect(digest.sessionId).toBe("resolved-sess");
  });
});

test("feedback evidence with nothing to resolve prints an unknown digest", async () => {
  await withDataDir(async (dataDir) => {
    const codexHome = tempDir("regimen-codex-home-");
    const { exit, stdout } = await runWith(["evidence"], {
      REGIMEN_DATA_DIR: dataDir,
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });

    expect(exit).toBe(0);
    const digest = JSON.parse(stdout);
    expect(digest.known).toBe(false);
    expect(digest.note).toContain("resolve");
  });
});

test("feedback evidence fails closed when REGIMEN_HARNESS names an unregistered harness", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout, stderr } = await runWith(["evidence"], {
      REGIMEN_DATA_DIR: dataDir,
      REGIMEN_HARNESS: "gemini",
    });
    expect(exit).not.toBe(0);
    expect(stderr).toContain("unsupported harness");
    expect(stdout).toBe("");
  });
});

test("feedback evidence fails fast when no home and no CODEX_HOME are set", async () => {
  await withDataDir(async (dataDir) => {
    // Clear HOME/USERPROFILE and CODEX_HOME so the command has no config home to
    // resolve; afterEach restores them. REGIMEN_HARNESS is pinned to codex.
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.CODEX_HOME;
    const { exit, stderr } = await runWith(["evidence"], {
      REGIMEN_DATA_DIR: dataDir,
      REGIMEN_HARNESS: "codex",
    });
    expect(exit).toBe(1);
    expect(stderr).toContain("HOME");
  });
});

test("feedback evidence fails closed when no harness can be resolved", async () => {
  await withDataDir(async (dataDir) => {
    // Every ambient harness marker is already cleared in beforeEach; pin only
    // the data dir so the resolver has nothing to go on and must refuse.
    const { exit, stderr } = await runWith(["evidence"], {
      REGIMEN_DATA_DIR: dataDir,
    });
    expect(exit).toBe(1);
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
    const { exit, stdout } = await runDir(["status"], dataDir);
    expect(exit).toBe(0);
    expect(stdout).toContain("feedback: enabled");
    expect(stdout).toContain("2026-05-21T12:00:00.000Z");
    expect(stdout).toContain("1024");
  });
});
