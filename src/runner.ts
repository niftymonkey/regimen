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

/** A single subprocess invocation: the program, then its arguments. */
export interface SpawnInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Spawn a subprocess and resolve with its exit code. The injected seam. */
export type SpawnFn = (invocation: SpawnInvocation) => Promise<number>;

export interface StepOutcome {
  readonly instrument: InstrumentName;
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
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

export async function runSteps(
  steps: ReadonlyArray<Step>,
  locatedPaths: ReadonlyMap<InstrumentName, string>,
  options: RunOptions,
): Promise<RunResult> {
  const outcomes: StepOutcome[] = [];
  let failed: StepOutcome | null = null;

  for (const step of steps) {
    const entryPath = locatedPaths.get(step.instrument);
    if (entryPath === undefined) {
      throw new Error(
        `no located entry path for instrument ${step.instrument}`,
      );
    }
    const exitCode = await options.spawn({
      command: "bun",
      args: [entryPath, step.verb, ...step.args],
    });
    const outcome: StepOutcome = {
      instrument: step.instrument,
      verb: step.verb,
      exitCode,
    };
    outcomes.push(outcome);
    if (exitCode !== 0) {
      if (failed === null) failed = outcome;
      if (options.failFast) break;
    }
  }

  return { outcomes, failed, exitCode: failed === null ? 0 : failed.exitCode };
}
