/**
 * The StepRunner: run an ordered list of Steps by spawning each instrument's
 * CLI as a subprocess, SEQUENTIALLY, never in parallel. The hub is a shell-out
 * orchestrator: it imports no instrument internals; it only spawns their CLIs
 * as `bun <entryPath> <verb> <...args>` and forwards exit codes.
 *
 * The spawn function is an INJECTED seam (a real two-adapter seam): production
 * passes a Bun.spawn-based impl with stdout/stderr inherited; tests pass a
 * recording fake that captures invocations and returns scripted exit codes, so
 * the runner's control flow (order, fail-fast, best-effort, aggregation) is
 * tested deterministically without spawning real subprocesses.
 *
 * failFast: true (install) stops the run on the first nonzero exit and does not
 * spawn later steps. failFast: false (uninstall) continues past a nonzero step
 * (best-effort teardown) but the aggregate result is nonzero if any step failed.
 */
import type { InstrumentName, Step } from "./plan.ts";

/** The label recorded for a step's outcome: its instrument, or "hub". */
type StepLabel = InstrumentName | "hub";

/**
 * A single subprocess invocation: the program, its arguments, and the working
 * directory to run it in. The cwd is load-bearing: every spawned instrument
 * subprocess must run in THAT instrument's own clone root so its cwd-relative
 * operations (for example `bun link`) act on the right package, not the hub's.
 */
export interface SpawnInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

/** Spawn a subprocess and resolve with its exit code. The injected seam. */
export type SpawnFn = (invocation: SpawnInvocation) => Promise<number>;

export interface StepOutcome {
  /** The instrument name, or "hub" for the hub's own self-link/unlink step. */
  readonly instrument: InstrumentName | "hub";
  readonly verb: string;
  readonly exitCode: number;
}

export interface RunResult {
  /** Each step that was actually spawned, in order, with its exit code. */
  readonly outcomes: ReadonlyArray<StepOutcome>;
  /** The first failing step, or null when every spawned step exited 0. */
  readonly failed: StepOutcome | null;
  /** 0 iff every spawned step exited 0; otherwise the first failing exit code. */
  readonly exitCode: number;
}

export interface RunOptions {
  readonly spawn: SpawnFn;
  readonly failFast: boolean;
  /** The hub's own clone root, the cwd for the hub self-link/unlink step. */
  readonly hubCloneRoot: string;
  /**
   * When true, the hub self-link/unlink step is previewed but not spawned: it
   * has no dry-run flag of its own (unlike the instrument steps, which forward
   * --dry-run and self-no-op), so a dry run must skip its real `bun link`.
   */
  readonly dryRun?: boolean;
}

/**
 * The production spawn adapter: spawn the real subprocess with stdout and
 * stderr inherited so a child's output streams to the parent terminal, and
 * resolve with its exit code. This is the only place that touches Bun.spawn;
 * the runner's control flow never does, which is why it stays deterministically
 * testable through the injected fake.
 */
export function realSpawn(invocation: SpawnInvocation): Promise<number> {
  const proc = Bun.spawn([invocation.command, ...invocation.args], {
    cwd: invocation.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

/**
 * Resolve one step (instrument or hub self-link) into its outcome label and the
 * concrete subprocess invocation: an instrument step runs
 * `bun <entryPath> <verb> <...args>` in that instrument's clone root; the hub
 * step runs `bun <link|unlink>` in the hub clone root. The cwd is load-bearing
 * in both cases.
 */
function resolveStep(
  step: Step,
  locatedPaths: ReadonlyMap<InstrumentName, string>,
  cloneRoots: ReadonlyMap<InstrumentName, string>,
  hubCloneRoot: string,
): { label: StepLabel; verb: string; invocation: SpawnInvocation } {
  if ("kind" in step) {
    return {
      label: "hub",
      verb: step.verb,
      invocation: { command: "bun", args: [step.verb], cwd: hubCloneRoot },
    };
  }

  const entryPath = locatedPaths.get(step.instrument);
  if (entryPath === undefined) {
    throw new Error(`no located entry path for instrument ${step.instrument}`);
  }
  const cwd = cloneRoots.get(step.instrument);
  if (cwd === undefined) {
    throw new Error(`no clone root for instrument ${step.instrument}`);
  }
  return {
    label: step.instrument,
    verb: step.verb,
    invocation: {
      command: "bun",
      args: [entryPath, step.verb, ...step.args],
      cwd,
    },
  };
}

export async function runSteps(
  steps: ReadonlyArray<Step>,
  locatedPaths: ReadonlyMap<InstrumentName, string>,
  cloneRoots: ReadonlyMap<InstrumentName, string>,
  options: RunOptions,
): Promise<RunResult> {
  const outcomes: StepOutcome[] = [];
  let failed: StepOutcome | null = null;

  for (const step of steps) {
    const { label, verb, invocation } = resolveStep(
      step,
      locatedPaths,
      cloneRoots,
      options.hubCloneRoot,
    );
    // The hub self-link has no dry-run flag of its own; under a dry run it is
    // previewed (in the printed plan) and skipped here so no real `bun link`
    // runs. Instrument steps always spawn: they forward --dry-run and self-no-op.
    if (options.dryRun === true && "kind" in step) {
      outcomes.push({ instrument: label, verb, exitCode: 0 });
      continue;
    }
    const exitCode = await options.spawn(invocation);
    const outcome: StepOutcome = { instrument: label, verb, exitCode };
    outcomes.push(outcome);
    if (exitCode !== 0) {
      if (failed === null) failed = outcome;
      if (options.failFast) break;
    }
  }

  return { outcomes, failed, exitCode: failed === null ? 0 : failed.exitCode };
}
