/**
 * The unified `regimen` dispatcher (ADR-0012). Two layers of coverage:
 *
 * 1. The install/uninstall ORCHESTRATION, driven through injected recording
 *    steps so the load-bearing invariants are asserted deterministically without
 *    standing up a real install: capture-before-gate ordering on install, the
 *    reverse on uninstall, fail-fast on install (a failing step stops the run),
 *    best-effort on uninstall (every step runs, aggregate is nonzero), and the
 *    single `regimen` self-link with each instrument told `selfLink: false`.
 * 2. The argv DISPATCH itself, driven in-process against the real facades for the
 *    read-only commands (status, list, daemon status, unknown), each pinned to a
 *    temp data dir so the host's real store is never touched.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstrumentSteps,
  install,
  runCli,
  uninstall,
} from "../src/cli/index.ts";

const COMMAND_NAMES = [
  "install",
  "update",
  "uninstall",
  "status",
  "daemon",
  "assess",
  "evidence",
  "audit",
  "list",
];

function captureStdout(run: () => void): string {
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = saved;
  }
  return stdout;
}

function captureStderr(run: () => void): string {
  let stderr = "";
  const saved = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = saved;
  }
  return stderr;
}

test("regimen --help prints the full usage to stdout and exits 0", () => {
  let exit: number | Promise<number> = 1;
  const stdout = captureStdout(() => {
    exit = runCli(["--help"]);
  });
  expect(exit).toBe(0);
  expect(stdout).toContain("regimen <command>");
  for (const name of COMMAND_NAMES) {
    expect(stdout).toContain(name);
  }
});

test("regimen -h prints the full usage to stdout and exits 0", () => {
  let exit: number | Promise<number> = 1;
  const stdout = captureStdout(() => {
    exit = runCli(["-h"]);
  });
  expect(exit).toBe(0);
  expect(stdout).toContain("regimen <command>");
  for (const name of COMMAND_NAMES) {
    expect(stdout).toContain(name);
  }
});

test("regimen help prints the full usage to stdout and exits 0", () => {
  let exit: number | Promise<number> = 1;
  const stdout = captureStdout(() => {
    exit = runCli(["help"]);
  });
  expect(exit).toBe(0);
  expect(stdout).toContain("regimen <command>");
  for (const name of COMMAND_NAMES) {
    expect(stdout).toContain(name);
  }
});

interface Call {
  readonly step: string;
  readonly selfLink?: boolean;
  readonly daemon?: boolean;
  readonly verb?: string;
}

/**
 * A recording fake of the instrument steps: each call is appended to `calls` in
 * order, and a step whose name is in `fail` returns 1. The default returns 0, so
 * a test opts a single step into failure to exercise fail-fast / best-effort.
 */
function recordingSteps(
  calls: Call[],
  fail: ReadonlySet<string> = new Set(),
): InstrumentSteps {
  const run = (call: Call): number => {
    calls.push(call);
    return fail.has(call.step) ? 1 : 0;
  };
  return {
    feedbackInstall: (o) =>
      run({ step: "feedbackInstall", selfLink: o.selfLink, daemon: o.daemon }),
    enforcementInstall: () => run({ step: "enforcementInstall" }),
    guidanceInstall: () => run({ step: "guidanceInstall" }),
    feedbackUninstall: (o) =>
      run({ step: "feedbackUninstall", selfLink: o.selfLink }),
    enforcementUninstall: () => run({ step: "enforcementUninstall" }),
    guidanceUninstall: () => run({ step: "guidanceUninstall" }),
    selfLink: (verb) => run({ step: "selfLink", verb }),
  };
}

test("install runs the three pillars in order (feedback, enforcement, guidance), then the one self-link", () => {
  const calls: Call[] = [];
  const exit = install(["install"], recordingSteps(calls));
  expect(exit).toBe(0);
  expect(calls.map((c) => c.step)).toEqual([
    "feedbackInstall",
    "enforcementInstall",
    "guidanceInstall",
    "selfLink",
  ]);
});

test("install tells each instrument selfLink:false and links the single regimen bin itself", () => {
  const calls: Call[] = [];
  install(["install"], recordingSteps(calls));
  const feedback = calls.find((c) => c.step === "feedbackInstall")!;
  expect(feedback.selfLink).toBe(false);
  const linkCalls = calls.filter((c) => c.step === "selfLink");
  expect(linkCalls).toHaveLength(1);
  expect(linkCalls[0]!.verb).toBe("link");
});

test("install is fail-fast: a failing capture step stops the run and enforcement never runs", () => {
  const calls: Call[] = [];
  const exit = install(
    ["install"],
    recordingSteps(calls, new Set(["feedbackInstall"])),
  );
  expect(exit).not.toBe(0);
  expect(calls.map((c) => c.step)).toEqual(["feedbackInstall"]);
});

test("install --no-daemon threads daemon:false to the feedback install", () => {
  const calls: Call[] = [];
  const exit = install(["install", "--no-daemon"], recordingSteps(calls));
  expect(exit).toBe(0);
  const feedback = calls.find((c) => c.step === "feedbackInstall")!;
  expect(feedback.daemon).toBe(false);
});

test("install without --no-daemon leaves the daemon step in place", () => {
  const calls: Call[] = [];
  install(["install"], recordingSteps(calls));
  const feedback = calls.find((c) => c.step === "feedbackInstall")!;
  expect(feedback.daemon).not.toBe(false);
});

test("install writes an env template into the config dir when one is absent", () => {
  const calls: Call[] = [];
  install(["install"], recordingSteps(calls));
  expect(existsSync(join(process.env.REGIMEN_CONFIG_DIR!, "env"))).toBe(true);
});

test("install --dry-run never writes an env template", () => {
  const calls: Call[] = [];
  install(["install", "--dry-run"], recordingSteps(calls));
  expect(existsSync(join(process.env.REGIMEN_CONFIG_DIR!, "env"))).toBe(false);
});

test("install succeeds when no config dir is resolvable; the template is skipped", () => {
  const saved = {
    config: process.env.REGIMEN_CONFIG_DIR,
    xdg: process.env.XDG_CONFIG_HOME,
    home: process.env.HOME,
  };
  delete process.env.REGIMEN_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.HOME;
  try {
    const calls: Call[] = [];
    expect(install(["install"], recordingSteps(calls))).toBe(0);
  } finally {
    if (saved.config !== undefined) {
      process.env.REGIMEN_CONFIG_DIR = saved.config;
    }
    if (saved.xdg !== undefined) process.env.XDG_CONFIG_HOME = saved.xdg;
    if (saved.home !== undefined) process.env.HOME = saved.home;
  }
});

test("install never overwrites an env template that already exists", () => {
  const calls: Call[] = [];
  const envPath = join(process.env.REGIMEN_CONFIG_DIR!, "env");
  writeFileSync(envPath, "REGIMEN_JUDGE_MODEL=already-set\n");
  install(["install"], recordingSteps(calls));
  expect(readFileSync(envPath, "utf8")).toBe(
    "REGIMEN_JUDGE_MODEL=already-set\n",
  );
});

test("uninstall never removes the env template; user configuration survives", () => {
  const calls: Call[] = [];
  install(["install"], recordingSteps(calls));
  const envPath = join(process.env.REGIMEN_CONFIG_DIR!, "env");
  expect(existsSync(envPath)).toBe(true);
  uninstall(["uninstall"], recordingSteps(calls));
  expect(existsSync(envPath)).toBe(true);
});

test("uninstall tears down in reverse (guidance, enforcement, feedback), self-unlink last", () => {
  const calls: Call[] = [];
  const exit = uninstall(["uninstall"], recordingSteps(calls));
  expect(exit).toBe(0);
  expect(calls.map((c) => c.step)).toEqual([
    "guidanceUninstall",
    "enforcementUninstall",
    "feedbackUninstall",
    "selfLink",
  ]);
  expect(calls.find((c) => c.step === "selfLink")!.verb).toBe("unlink");
});

test("uninstall is best-effort: a failing guidance teardown still runs the later steps and aggregates nonzero", () => {
  const calls: Call[] = [];
  const exit = uninstall(
    ["uninstall"],
    recordingSteps(calls, new Set(["guidanceUninstall"])),
  );
  expect(exit).not.toBe(0);
  expect(calls.map((c) => c.step)).toEqual([
    "guidanceUninstall",
    "enforcementUninstall",
    "feedbackUninstall",
    "selfLink",
  ]);
});

test("uninstall tells the feedback teardown selfLink:false so only the regimen unlink runs", () => {
  const calls: Call[] = [];
  uninstall(["uninstall"], recordingSteps(calls));
  expect(calls.find((c) => c.step === "feedbackUninstall")!.selfLink).toBe(
    false,
  );
});

const tempDirs: string[] = [];
let savedDataDir: string | undefined;
let savedConfigDir: string | undefined;
let savedHarness: string | undefined;

// Every test runs in an isolated temp data dir, temp config dir, and with a
// pinned harness, so the install/uninstall orchestration runs its per-harness
// path deterministically (the manifest write needs a resolved harness) and
// never reads or writes the host's real store, real config home (the env
// template install writes there), or ambient harness markers.
beforeEach(() => {
  savedDataDir = process.env.REGIMEN_DATA_DIR;
  savedConfigDir = process.env.REGIMEN_CONFIG_DIR;
  savedHarness = process.env.REGIMEN_HARNESS;
  tempDataDir();
  process.env.REGIMEN_CONFIG_DIR = tempDir("regimen-dispatch-config-");
  process.env.REGIMEN_HARNESS = "codex";
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.REGIMEN_DATA_DIR;
  else process.env.REGIMEN_DATA_DIR = savedDataDir;
  if (savedConfigDir === undefined) delete process.env.REGIMEN_CONFIG_DIR;
  else process.env.REGIMEN_CONFIG_DIR = savedConfigDir;
  if (savedHarness === undefined) delete process.env.REGIMEN_HARNESS;
  else process.env.REGIMEN_HARNESS = savedHarness;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function tempDataDir(): string {
  const dir = tempDir("regimen-dispatch-");
  process.env.REGIMEN_DATA_DIR = dir;
  return dir;
}

test("regimen status dispatches to the feedback program status", async () => {
  tempDataDir();
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await runCli(["status"]);
    expect(exit).toBe(0);
  } finally {
    process.stdout.write = saved;
  }
  expect(stdout).toContain("feedback: disabled");
  expect(stdout).toContain("daemon: not running");
});

test("regimen daemon status dispatches to the feedback daemon status", async () => {
  tempDataDir();
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await runCli(["daemon", "status"]);
    expect(exit).toBe(0);
  } finally {
    process.stdout.write = saved;
  }
  expect(stdout).toContain("daemon: not running");
});

test("regimen daemon with no verb fails closed with a usage line", async () => {
  tempDataDir();
  let stderr = "";
  const saved = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await runCli(["daemon"]);
    expect(exit).toBe(1);
  } finally {
    process.stderr.write = saved;
  }
  expect(stderr).toContain("usage: regimen daemon");
});

test("regimen assess --help prints usage and exits 0 without running a real assessment", async () => {
  tempDataDir();
  // No ANTHROPIC_API_KEY, no session, no claude on PATH: a real assess call
  // would fail loudly (or, with a key set, spend money). --help must never
  // reach that code at all.
  delete process.env.ANTHROPIC_API_KEY;
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  let exit: number | Promise<number> = 1;
  try {
    exit = await runCli(["assess", "--help"]);
  } finally {
    process.stdout.write = saved;
  }
  expect(exit).toBe(0);
  expect(stdout).toContain("assess");
  expect(stdout).not.toContain("{");
});

test("regimen list --help prints usage and exits 0 without touching the store", async () => {
  const dir = tempDataDir();
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  let exit: number | Promise<number> = 1;
  try {
    exit = await runCli(["list", "--help"]);
  } finally {
    process.stdout.write = saved;
  }
  expect(exit).toBe(0);
  expect(stdout).toContain("regimen list");
  expect(existsSync(join(dir, "feedback.db"))).toBe(false);
});

test("regimen rollup --help prints usage and exits 0 without reading verdicts or resolving a judge", async () => {
  const dir = tempDataDir();
  // No ANTHROPIC_API_KEY: a real rollup over judged verdicts would resolve a
  // judge backend (and with a key set, spend money). --help must short-circuit
  // before the handler, so neither the store nor the resolver is ever touched.
  delete process.env.ANTHROPIC_API_KEY;
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  let exit: number | Promise<number> = 1;
  try {
    exit = await runCli(["rollup", "--help"]);
  } finally {
    process.stdout.write = saved;
  }
  expect(exit).toBe(0);
  expect(stdout).toContain("regimen rollup");
  // The handler's empty-slice line, absent here: the facade never ran.
  expect(stdout).not.toContain("nothing to roll up");
  expect(existsSync(join(dir, "feedback.db"))).toBe(false);
});

test("regimen audit --help prints usage and exits 0 without auditing or resolving a judge", async () => {
  const dir = tempDataDir();
  // No ANTHROPIC_API_KEY: an idle lever on a real audit would resolve a judge
  // backend and pay for a deep-dive. --help must short-circuit before the
  // handler, so the setup source, the store, and the resolver are never touched.
  delete process.env.ANTHROPIC_API_KEY;
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  let exit: number | Promise<number> = 1;
  try {
    exit = await runCli(["audit", "--help"]);
  } finally {
    process.stdout.write = saved;
  }
  expect(exit).toBe(0);
  expect(stdout).toContain("regimen audit");
  // The handler's summary lines, absent here: the facade never ran.
  expect(stdout).not.toContain("nothing to audit");
  expect(stdout).not.toContain("holding");
  expect(existsSync(join(dir, "feedback.db"))).toBe(false);
});

test("regimen install --help prints usage and exits 0 without installing anything", () => {
  tempDataDir();
  const stdout = captureStdout(() => {
    const exit = runCli(["install", "--help"]);
    expect(exit).toBe(0);
  });
  expect(stdout).toContain("regimen install");
  // The real install's opening line, absent here: the handler never ran.
  expect(stdout).not.toContain("capture then enforcement then guidance");
});

test("regimen daemon -h prints usage and exits 0 without inspecting the daemon", () => {
  tempDataDir();
  const stdout = captureStdout(() => {
    const exit = runCli(["daemon", "-h"]);
    expect(exit).toBe(0);
  });
  expect(stdout).toContain("regimen daemon");
  expect(stdout).not.toContain("not running");
});

test("regimen list dispatches to the feedback list facade and renders an empty result", async () => {
  tempDataDir();
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await runCli(["list", "--json"]);
    expect(exit).toBe(0);
  } finally {
    process.stdout.write = saved;
  }
  expect(JSON.parse(stdout)).toEqual([]);
});

test("regimen audit dispatches to the feedback audit facade and reports on an empty store", async () => {
  tempDataDir();
  let stdout = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    // An empty store means every currently-in-force practice is too-new (zero
    // eligible conversations), so no practice is idle and the audit makes NO model
    // call: the dispatch resolves and returns 0 with a deterministic summary, with
    // no judge backend configured.
    const exit = await runCli(["audit"]);
    expect(exit).toBe(0);
  } finally {
    process.stdout.write = saved;
  }
  expect(stdout.length).toBeGreaterThan(0);
});

test("an unknown command names the bad command and prints the full usage to stderr, exit 1", () => {
  let exit: number | Promise<number> = 0;
  const stderr = captureStderr(() => {
    exit = runCli(["bogus"]);
  });
  expect(exit).toBe(1);
  expect(stderr).toContain("unknown command: bogus");
  expect(stderr).toContain("regimen <command>");
  for (const name of COMMAND_NAMES) {
    expect(stderr).toContain(name);
  }
});

test("no command at all prints the full usage to stderr and exits 1", () => {
  let exit: number | Promise<number> = 0;
  const stderr = captureStderr(() => {
    exit = runCli([]);
  });
  expect(exit).toBe(1);
  expect(stderr).toContain("regimen <command>");
  for (const name of COMMAND_NAMES) {
    expect(stderr).toContain(name);
  }
});
