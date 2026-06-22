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
import { mkdtempSync, rmSync } from "node:fs";
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
  readonly gates?: ReadonlyArray<string>;
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
    enforcementInstall: (o) =>
      run({ step: "enforcementInstall", gates: o.gates }),
    feedbackUninstall: (o) =>
      run({ step: "feedbackUninstall", selfLink: o.selfLink }),
    enforcementUninstall: () => run({ step: "enforcementUninstall" }),
    selfLink: (verb) => run({ step: "selfLink", verb }),
  };
}

test("install runs capture (feedback) before the gate (enforcement), then the one self-link", () => {
  const calls: Call[] = [];
  const exit = install(["install"], recordingSteps(calls));
  expect(exit).toBe(0);
  expect(calls.map((c) => c.step)).toEqual([
    "feedbackInstall",
    "enforcementInstall",
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

test("install is fail-fast: a failing capture step stops the run and the gate never wires", () => {
  const calls: Call[] = [];
  const exit = install(
    ["install"],
    recordingSteps(calls, new Set(["feedbackInstall"])),
  );
  expect(exit).not.toBe(0);
  expect(calls.map((c) => c.step)).toEqual(["feedbackInstall"]);
});

test("install wires all three gates by default", () => {
  const calls: Call[] = [];
  install(["install"], recordingSteps(calls));
  const gate = calls.find((c) => c.step === "enforcementInstall")!;
  expect(gate.gates).toEqual(["rm-rf", "em-dash", "inline-message"]);
});

test("install --no-gates passes an empty gate set to enforcement", () => {
  const calls: Call[] = [];
  install(["install", "--no-gates"], recordingSteps(calls));
  const gate = calls.find((c) => c.step === "enforcementInstall")!;
  expect(gate.gates).toEqual([]);
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

test("uninstall tears down in reverse: gate (enforcement) before capture (feedback), self-unlink last", () => {
  const calls: Call[] = [];
  const exit = uninstall(["uninstall"], recordingSteps(calls));
  expect(exit).toBe(0);
  expect(calls.map((c) => c.step)).toEqual([
    "enforcementUninstall",
    "feedbackUninstall",
    "selfLink",
  ]);
  expect(calls.find((c) => c.step === "selfLink")!.verb).toBe("unlink");
});

test("uninstall is best-effort: a failing gate teardown still runs the later steps and aggregates nonzero", () => {
  const calls: Call[] = [];
  const exit = uninstall(
    ["uninstall"],
    recordingSteps(calls, new Set(["enforcementUninstall"])),
  );
  expect(exit).not.toBe(0);
  expect(calls.map((c) => c.step)).toEqual([
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
let savedHarness: string | undefined;

// Every test runs in an isolated temp data dir and with a pinned harness, so the
// install/uninstall orchestration runs its per-harness path deterministically
// (the manifest write needs a resolved harness) and never reads or writes the
// host's real store or ambient harness markers.
beforeEach(() => {
  savedDataDir = process.env.REGIMEN_DATA_DIR;
  savedHarness = process.env.REGIMEN_HARNESS;
  tempDataDir();
  process.env.REGIMEN_HARNESS = "codex";
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.REGIMEN_DATA_DIR;
  else process.env.REGIMEN_DATA_DIR = savedDataDir;
  if (savedHarness === undefined) delete process.env.REGIMEN_HARNESS;
  else process.env.REGIMEN_HARNESS = savedHarness;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-dispatch-"));
  tempDirs.push(dir);
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
