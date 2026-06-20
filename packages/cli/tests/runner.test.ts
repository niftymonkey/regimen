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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstrumentName, Step } from "../src/plan.ts";
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

const locatedPaths = new Map<InstrumentName, string>([
  ["feedback", "/clones/regimen-feedback/src/cli/index.ts"],
  ["enforcement", "/clones/regimen-enforcement/src/cli/index.ts"],
]);

const cloneRoots = new Map<InstrumentName, string>([
  ["feedback", "/clones/regimen-feedback"],
  ["enforcement", "/clones/regimen-enforcement"],
]);

const CLI_ROOT = "/clones/regimen";

test("each step spawns `bun <entryPath> <verb> <...args>` in order", async () => {
  const { spawn, calls } = recordingSpawn([0, 0]);
  const result = await runSteps(installSteps, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
  });

  expect(calls).toEqual([
    {
      command: "bun",
      args: [
        "/clones/regimen-feedback/src/cli/index.ts",
        "install",
        "--dry-run",
      ],
      cwd: "/clones/regimen-feedback",
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
      cwd: "/clones/regimen-enforcement",
    },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.failed).toBeNull();
});

test("instrument steps carry the childEnv overlay (the harness identity) to the spawn", async () => {
  const { spawn, calls } = recordingSpawn([0, 0]);
  await runSteps(installSteps, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
    childEnv: { REGIMEN_HARNESS: "codex" },
  });

  // Every instrument child is handed the harness as an opaque env string, not a
  // flag; the args never carry --harness.
  for (const call of calls) {
    expect(call.env).toEqual({ REGIMEN_HARNESS: "codex" });
    expect(call.args).not.toContain("--harness");
  }
});

test("the cli self-link step does not carry the childEnv overlay (it needs no harness)", async () => {
  const stepsWithCliLink: ReadonlyArray<Step> = [
    { instrument: "feedback", verb: "install", args: [] },
    { kind: "cli", verb: "link" },
  ];
  const { spawn, calls } = recordingSpawn([0, 0]);
  await runSteps(stepsWithCliLink, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
    childEnv: { REGIMEN_HARNESS: "codex" },
  });

  const cliCall = calls.find((c) => c.args[0] === "link");
  expect(cliCall?.env).toBeUndefined();
});

test("each spawned step runs with cwd set to that instrument's clone root", async () => {
  const { spawn, calls } = recordingSpawn([0, 0]);
  await runSteps(installSteps, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
  });

  expect(calls.map((c) => c.cwd)).toEqual([
    "/clones/regimen-feedback",
    "/clones/regimen-enforcement",
  ]);
});

test("the cli self-link step spawns `bun link` at the cli clone root, last", async () => {
  const stepsWithCliLink: ReadonlyArray<Step> = [
    ...installSteps,
    { kind: "cli", verb: "link" },
  ];
  const { spawn, calls } = recordingSpawn([0, 0, 0]);
  await runSteps(stepsWithCliLink, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
  });

  const last = calls[calls.length - 1];
  expect(last).toEqual({ command: "bun", args: ["link"], cwd: CLI_ROOT });
});

test("under dryRun the cli self-link is previewed, not spawned, while instrument steps still spawn", async () => {
  const stepsWithCliLink: ReadonlyArray<Step> = [
    ...installSteps,
    { kind: "cli", verb: "link" },
  ];
  const { spawn, calls } = recordingSpawn([0, 0, 0]);
  await runSteps(stepsWithCliLink, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
    dryRun: true,
  });

  // The two instrument steps still spawn (they forward --dry-run and self-no-op),
  // but the cli `bun link` is preview-only and never reaches the spawn seam.
  expect(calls.map((c) => c.args)).toEqual([
    ["/clones/regimen-feedback/src/cli/index.ts", "install", "--dry-run"],
    [
      "/clones/regimen-enforcement/src/cli/index.ts",
      "install",
      "--dry-run",
      "--gate",
      "rm-rf",
    ],
  ]);
  expect(calls.some((c) => c.args[0] === "link")).toBe(false);
});

test("the cli self-unlink step spawns `bun unlink` at the cli clone root, first", async () => {
  const stepsWithCliUnlink: ReadonlyArray<Step> = [
    { kind: "cli", verb: "unlink" },
    { instrument: "enforcement", verb: "uninstall", args: [] },
    { instrument: "feedback", verb: "uninstall", args: [] },
  ];
  const { spawn, calls } = recordingSpawn([0, 0, 0]);
  await runSteps(stepsWithCliUnlink, locatedPaths, cloneRoots, {
    spawn,
    failFast: false,
    cliPackageRoot: CLI_ROOT,
  });

  expect(calls[0]).toEqual({ command: "bun", args: ["unlink"], cwd: CLI_ROOT });
});

test("failFast halts the run before the next step on a nonzero exit", async () => {
  const { spawn, calls } = recordingSpawn([3, 0]);
  const result = await runSteps(installSteps, locatedPaths, cloneRoots, {
    spawn,
    failFast: true,
    cliPackageRoot: CLI_ROOT,
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
  const result = await runSteps(uninstallSteps, locatedPaths, cloneRoots, {
    spawn,
    failFast: false,
    cliPackageRoot: CLI_ROOT,
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

test("real spawn: the per-invocation env overlay merges over the parent env", async () => {
  // The child probes two vars and encodes the result in its exit code: one set
  // only on the parent (proves the parent env is forwarded, the path the
  // config-home var like CODEX_HOME rides) and one set only on the invocation
  // overlay (proves the overlay reaches the child, the path REGIMEN_HARNESS
  // rides). Exit 0 only when BOTH arrive; a distinct nonzero otherwise.
  const printer = mkdtempSync(join(tmpdir(), "regimen-cli-env-"));
  const script = join(printer, "probe-env.ts");
  writeFileSync(
    script,
    [
      'const parent = process.env.REGIMEN_PARENT_ONLY === "from-parent";',
      'const overlay = process.env.REGIMEN_OVERLAY === "from-overlay";',
      "process.exit(parent && overlay ? 0 : parent ? 7 : 8);",
      "",
    ].join("\n"),
  );
  const priorParent = process.env.REGIMEN_PARENT_ONLY;
  process.env.REGIMEN_PARENT_ONLY = "from-parent";
  try {
    // realSpawn merges invocation.env OVER the parent process.env, so the child
    // sees both the parent-only var and the overlay var.
    const code = await realSpawn({
      command: "bun",
      args: [script],
      cwd: printer,
      env: { REGIMEN_OVERLAY: "from-overlay" },
    });
    expect(code).toBe(0);
  } finally {
    rmSync(printer, { recursive: true, force: true });
    if (priorParent === undefined) delete process.env.REGIMEN_PARENT_ONLY;
    else process.env.REGIMEN_PARENT_ONLY = priorParent;
  }
});

test("real spawn: a genuine feedback install --dry-run exits 0 through the runner", async () => {
  // The cli package root is two levels up from this test file's dir; with the
  // cli package at packages/cli the convention join lands on packages/feedback.
  const cliPackageRoot = join(import.meta.dir, "..");
  const feedback = locate("feedback", {
    cliPackageRoot,
    env: process.env,
    overrides: {},
  });
  if ("message" in feedback) {
    throw new Error(
      `the real-spawn smoke needs the feedback sibling package: ${feedback.message}`,
    );
  }

  // Pin a supported harness for the spawned feedback install so this smoke
  // proves the spawn wiring and exit-code mapping deterministically, regardless
  // of which agent CLI the suite runs inside. feedback's install fails closed on
  // a harness with no support entry yet, which is its own concern, not the
  // runner's; realSpawn inherits process.env, so the pin reaches the child.
  const priorHarness = process.env.REGIMEN_HARNESS;
  process.env.REGIMEN_HARNESS = "codex";
  const codexHome = mkdtempSync(join(tmpdir(), "regimen-cli-smoke-"));
  try {
    const steps: ReadonlyArray<Step> = [
      {
        instrument: "feedback",
        verb: "install",
        args: ["--dry-run", "--codex-home", codexHome],
      },
    ];
    const located = new Map<InstrumentName, string>([
      ["feedback", feedback.entryPath],
    ]);
    const roots = new Map<InstrumentName, string>([
      ["feedback", feedback.cloneRoot],
    ]);
    const result = await runSteps(steps, located, roots, {
      spawn: realSpawn,
      failFast: true,
      cliPackageRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.failed).toBeNull();
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    if (priorHarness === undefined) delete process.env.REGIMEN_HARNESS;
    else process.env.REGIMEN_HARNESS = priorHarness;
  }
});
