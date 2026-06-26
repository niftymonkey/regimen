/**
 * The wire-hooks / unwire-hooks / install / uninstall CLI commands (capture-only),
 * driven IN-PROCESS through the exported command facades (ADR-0012) rather than by
 * spawning a `bun` subprocess per assertion. The pure merge is covered by
 * install-capture-hooks.test.ts; here we cover the CLI seam: resolving the
 * harness from the environment, reading and writing the real
 * `<configHome>/hooks.json` on disk, the per-event preview/commit lines, and the
 * install/uninstall orchestration over those steps.
 *
 * Feedback wires only the capture hook; enforcement gates come from the separate
 * enforcement package, so no gate leaves are ever written here.
 *
 * Why in-process: each `Bun.spawn(["bun", CLI, ...])` paid a cold-start that
 * historically raced this suite's 30s per-test timeout under load. Calling the
 * facades directly drops the per-test body from ~200ms to ~5ms and removes the
 * flake. Each test runs inside an isolated env (temp HOME, temp CODEX_HOME, temp
 * REGIMEN_DATA_DIR) pinned in `process.env`, with stdout/stderr captured by
 * patching `process.stdout.write` / `process.stderr.write`; `afterEach` restores
 * both the env and the write streams so the in-process driving leaves no global
 * state behind.
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
import { dispatchFeedback } from "./facade-dispatch.ts";

const CAPTURE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
];

/**
 * The per-harness marker env vars the resolver falls back to when REGIMEN_HARNESS
 * is unset. The live machine running this suite can itself be inside one of these
 * harnesses (e.g. CLAUDECODE=1), so the fail-closed test must clear all of them
 * (and REGIMEN_HARNESS) to be hermetic rather than resolving the ambient harness.
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
  "CODEX_HOME",
  "HOME",
  "REGIMEN_DATA_DIR",
];

interface CliRun {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Leaf {
  type: string;
  command: string;
  _regimen?: { v: number; role: string; id?: string };
}

let home: string;
let codexHome: string;
let dataDir: string;
let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "regimen-wire-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "regimen-wire-codex-"));
  dataDir = mkdtempSync(join(tmpdir(), "regimen-wire-data-"));

  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];

  // Clear every ambient harness marker first, then pin codex explicitly, so the
  // suite is independent of whichever harness CLI happens to be running it. HOME,
  // CODEX_HOME, and REGIMEN_DATA_DIR are pinned to throwaway temp dirs so the
  // host's real config and data are never touched (this fully isolates the
  // install/uninstall tests, which read all three).
  for (const marker of HARNESS_MARKERS) delete process.env[marker];
  process.env.REGIMEN_HARNESS = "codex";
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
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
  for (const dir of [home, codexHome, dataDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Drive one command in-process via the facade dispatch, capturing stdout and
 * stderr. The dispatch may return a number or a Promise<number>; awaiting a
 * number is a no-op, so this handles both the synchronous wire/unwire path and
 * any async command uniformly.
 */
async function runCommand(...args: string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  // The real write returns a boolean (backpressure); the capture mirrors that
  // contract so nothing downstream of the write call misbehaves.
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  const exit = await dispatchFeedback(args);
  return { exit, stdout, stderr };
}

const hooksPath = (): string => join(codexHome, "hooks.json");

function readHooks(): {
  hooks?: Record<string, Array<{ hooks: Leaf[] }>>;
} {
  return JSON.parse(readFileSync(hooksPath(), "utf8"));
}

test("wire-hooks writes hooks.json with capture on five events and no gate leaves", async () => {
  const { exit } = await runCommand("wire-hooks");
  expect(exit).toBe(0);

  const parsed = readHooks();
  for (const event of CAPTURE_EVENTS) {
    const leaves = (parsed.hooks?.[event] ?? []).flatMap((g) => g.hooks);
    expect(leaves.some((l) => l._regimen?.role === "capture")).toBe(true);
    // No event carries a gate leaf: Feedback wires capture only.
    expect(leaves.filter((l) => l._regimen?.role === "gate")).toHaveLength(0);
  }
});

test("wire-hooks for codex prints the fresh-hooks-need-trust notice", async () => {
  const { exit, stdout } = await runCommand("wire-hooks");
  expect(exit).toBe(0);
  // Codex will not fire freshly-installed hooks until they are trusted once, so
  // the wire surfaces a one-line notice; without it first-run capture is silently
  // empty. The descriptor carries the message; the CLI prints it on a successful
  // codex wire.
  expect(stdout).toContain("trust");
  expect(stdout).toContain("--dangerously-bypass-hook-trust");
});

test("wire-hooks for a non-codex harness prints no trust notice", async () => {
  // Claude fires freshly-installed hooks without a trust step, so its descriptor
  // carries no firstUseNotice and the wire stays quiet about trust. Claude's
  // config home falls back to <HOME>/.claude (the temp HOME), so this is isolated.
  process.env.REGIMEN_HARNESS = "claude";
  const { exit, stdout } = await runCommand("wire-hooks");
  expect(exit).toBe(0);
  expect(stdout).not.toContain("trust");
});

test("wire-hooks fails closed when no harness can be resolved", async () => {
  // Clear every ambient harness marker AND the pinned override, so the resolver
  // has nothing to go on and the command must refuse rather than guess.
  for (const marker of HARNESS_MARKERS) delete process.env[marker];

  const run = await runCommand("wire-hooks");
  expect(run.exit).not.toBe(0);
  expect(run.stderr).toContain("could not determine the harness");
  expect(existsSync(hooksPath())).toBe(false);
});

test("wire-hooks fails closed on a known harness with no registered descriptor", async () => {
  // `cursor` is a valid harness identifier but has no descriptor registered
  // yet, so the install path must refuse it rather than guess.
  process.env.REGIMEN_HARNESS = "cursor";

  const run = await runCommand("wire-hooks");
  expect(run.exit).not.toBe(0);
  expect(run.stderr).toContain("unsupported harness");
  expect(existsSync(hooksPath())).toBe(false);
});

test("wire-hooks --dry-run previews capture only and writes nothing", async () => {
  const run = await runCommand("wire-hooks", "--dry-run");
  expect(run.exit).toBe(0);
  expect(run.stdout).toContain("would wire capture on SessionStart");
  expect(run.stdout).toContain("would wire capture on PreToolUse");
  // Capture-only: nothing about gates is ever previewed.
  expect(run.stdout).not.toContain("gate");
  expect(existsSync(hooksPath())).toBe(false);
});

test("wire-hooks preserves the user's own hooks and is idempotent on re-run", async () => {
  const userFile = {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
      ],
    },
  };
  writeFileSync(hooksPath(), JSON.stringify(userFile));

  await runCommand("wire-hooks");
  const second = await runCommand("wire-hooks");
  expect(second.exit).toBe(0);
  expect(second.stdout).toContain("already wired");

  const parsed = readHooks();
  const pre = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
  // The user's gate survives, exactly one capture leaf exists (no duplicate).
  expect(pre.some((l) => l.command === "bun /home/me/my-gate.ts")).toBe(true);
  expect(pre.filter((l) => l._regimen?.role === "capture")).toHaveLength(1);
});

test("wire-hooks preserves a foreign enforcement gate leaf verbatim", async () => {
  const gateLeaf = {
    type: "command",
    command: "bun /opt/regimen-enforcement/gates/rm-rf.ts",
    _regimen: { v: 1, role: "gate", id: "rm-rf" },
  };
  const enforcementFile = {
    hooks: { PreToolUse: [{ hooks: [gateLeaf] }] },
  };
  writeFileSync(hooksPath(), JSON.stringify(enforcementFile));

  await runCommand("wire-hooks");

  const parsed = readHooks();
  const pre = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
  // The enforcement gate leaf is untouched; Feedback's capture lands after it.
  expect(pre.find((l) => l._regimen?.role === "gate")).toEqual(gateLeaf);
  expect(pre.filter((l) => l._regimen?.role === "capture")).toHaveLength(1);

  // Unwiring removes only Feedback's capture, leaving the gate leaf in place.
  await runCommand("unwire-hooks");
  const after = readHooks();
  const preAfter = (after.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
  expect(preAfter).toEqual([gateLeaf]);
});

test("unwire-hooks removes Feedback's entries and keeps the user's", async () => {
  const userFile = {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
      ],
    },
  };
  writeFileSync(hooksPath(), JSON.stringify(userFile));
  await runCommand("wire-hooks");

  const { exit, stdout } = await runCommand("unwire-hooks");
  expect(exit).toBe(0);
  expect(stdout).toContain("removed capture on SessionStart");

  const parsed = readHooks();
  expect(parsed.hooks?.PreToolUse).toEqual([
    { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
  ]);
  expect(parsed.hooks?.SessionStart).toBeUndefined();
});

test("install --dry-run previews a capture-only wiring with zero gate leaves and writes nothing", async () => {
  const { exit, stdout } = await runCommand("install", "--dry-run");
  expect(exit).toBe(0);
  // Feedback: enable + daemon service.
  expect(stdout).toContain("would enable feedback");
  expect(stdout).toMatch(/would write .*regimen-feedback/);
  // Capture hook, on PreToolUse among the five events.
  expect(stdout).toContain("would wire capture on PreToolUse");
  // No gates: Feedback no longer wires enforcement.
  expect(stdout).not.toContain("gate");
  // Guidance: both bundled skills.
  expect(stdout).toContain("regimen-evidence/SKILL.md");
  expect(stdout).toContain("regimen-judgment/SKILL.md");
  // CLI on PATH.
  expect(stdout).toContain("would run: bun link");
  expect(stdout).toContain("nothing was changed");

  // No side effects.
  expect(existsSync(hooksPath())).toBe(false);
  expect(existsSync(join(codexHome, "skills", "regimen-evidence"))).toBe(false);
});

test("uninstall --dry-run previews teardown and writes nothing", async () => {
  // Pre-wire a real hooks.json so the teardown has something to preview.
  await runCommand("wire-hooks");
  const before = readFileSync(hooksPath(), "utf8");

  const { exit, stdout } = await runCommand("uninstall", "--dry-run");
  expect(exit).toBe(0);
  expect(stdout).toContain("would disable feedback");
  expect(stdout).toContain("would remove capture on PreToolUse");
  expect(stdout).toContain("would run: bun unlink");
  expect(stdout).toContain("nothing was changed");

  // The hooks.json is untouched by a dry run.
  expect(readFileSync(hooksPath(), "utf8")).toBe(before);
});

test("uninstall is best effort: a failing early step does not skip later teardown", async () => {
  // A malformed hooks.json makes the unwire step fail (return non-zero).
  writeFileSync(hooksPath(), JSON.stringify({ hooks: "nope" }));

  const { exit, stdout, stderr } = await runCommand("uninstall", "--dry-run");
  // The failure is surfaced and propagated to the exit code.
  expect(stderr).toContain("hooks");
  expect(exit).not.toBe(0);
  // But the later steps still ran (skill + daemon teardown previews present),
  // which a short-circuiting `||=` would have skipped.
  expect(stdout).toContain("would remove");
  expect(stdout).toContain("regimen-evidence");
  expect(stdout).toContain("would run: bun unlink");
});
