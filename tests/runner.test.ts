/**
 * The StepRunner. Most tests drive the runner through an injected recording
 * fake spawn that captures each invocation and returns a scripted exit code, so
 * the control flow (spawn command, sequential order, fail-fast halt, best-effort
 * continue, exit aggregation) is verified deterministically without real
 * subprocesses. One thin real-subprocess smoke spawns a genuine, side-effect-free
 * `feedback install --dry-run` to prove the production spawn wiring and
 * exit-code mapping are real.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Step } from "../src/plan.ts";
import { locate } from "../src/locator.ts";
import {
  type SpawnFn,
  type SpawnInvocation,
  realSpawn,
  runSteps,
} from "../src/runner.ts";

/** A recording fake spawn: scripts an exit code per call index, captures calls. */
function recordingSpawn(exitCodes: ReadonlyArray<number>): {
  spawn: SpawnFn;
  calls: SpawnInvocation[];
} {
  const calls: SpawnInvocation[] = [];
  const spawn: SpawnFn = (invocation) => {
    const code = exitCodes[calls.length] ?? 0;
    calls.push(invocation);
    return Promise.resolve(code);
  };
  return { spawn, calls };
}

const installSteps: ReadonlyArray<Step> = [
  { instrument: "feedback", verb: "install", args: ["--dry-run"] },
  {
    instrument: "enforcement",
    verb: "install",
    args: ["--dry-run", "--gate", "rm-rf"],
  },
];

const locatedPaths = new Map<string, string>([
  ["feedback", "/clones/regimen-feedback/src/cli/index.ts"],
  ["enforcement", "/clones/regimen-enforcement/src/cli/index.ts"],
]) as ReadonlyMap<Step["instrument"], string>;

test("each step spawns `bun <entryPath> <verb> <...args>` in order", async () => {
  const { spawn, calls } = recordingSpawn([0, 0]);
  const result = await runSteps(installSteps, locatedPaths, {
    spawn,
    failFast: true,
  });

  expect(calls).toEqual([
    {
      command: "bun",
      args: [
        "/clones/regimen-feedback/src/cli/index.ts",
        "install",
        "--dry-run",
      ],
    },
    {
      command: "bun",
      args: [
        "/clones/regimen-enforcement/src/cli/index.ts",
        "install",
        "--dry-run",
        "--gate",
        "rm-rf",
      ],
    },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.failed).toBeNull();
});

test("failFast halts the run before the next step on a nonzero exit", async () => {
  const { spawn, calls } = recordingSpawn([3, 0]);
  const result = await runSteps(installSteps, locatedPaths, {
    spawn,
    failFast: true,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.args[0]).toBe("/clones/regimen-feedback/src/cli/index.ts");
  expect(result.exitCode).toBe(3);
  expect(result.failed?.instrument).toBe("feedback");
  expect(result.outcomes).toHaveLength(1);
});

test("best-effort (failFast false) continues past a nonzero step and aggregates nonzero", async () => {
  const uninstallSteps: ReadonlyArray<Step> = [
    { instrument: "enforcement", verb: "uninstall", args: [] },
    { instrument: "feedback", verb: "uninstall", args: [] },
  ];
  const { spawn, calls } = recordingSpawn([5, 0]);
  const result = await runSteps(uninstallSteps, locatedPaths, {
    spawn,
    failFast: false,
  });

  expect(calls).toHaveLength(2);
  expect(result.outcomes.map((o) => o.instrument)).toEqual([
    "enforcement",
    "feedback",
  ]);
  // The aggregate is the first failing exit code even though later steps ran.
  expect(result.exitCode).toBe(5);
  expect(result.failed?.instrument).toBe("enforcement");
});

test("real spawn: a genuine feedback install --dry-run exits 0 through the runner", async () => {
  // The hub's own clone root is two levels up from this test file's dir.
  const hubCloneRoot = join(import.meta.dir, "..");
  const feedback = locate("feedback", {
    hubCloneRoot,
    env: process.env,
    overrides: {},
  });
  if ("message" in feedback) {
    throw new Error(
      `the real-spawn smoke needs the feedback sibling clone: ${feedback.message}`,
    );
  }

  const codexHome = mkdtempSync(join(tmpdir(), "regimen-hub-smoke-"));
  try {
    const steps: ReadonlyArray<Step> = [
      {
        instrument: "feedback",
        verb: "install",
        args: ["--dry-run", "--codex-home", codexHome],
      },
    ];
    const located = new Map<Step["instrument"], string>([
      ["feedback", feedback.entryPath],
    ]);
    const result = await runSteps(steps, located, {
      spawn: realSpawn,
      failFast: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.failed).toBeNull();
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
