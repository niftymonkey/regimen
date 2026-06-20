/**
 * The StepRunner: run an ordered list of Steps by spawning each instrument's
 * CLI as a subprocess, SEQUENTIALLY, never in parallel. The CLI is a shell-out
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

/** The label recorded for a step's outcome: its instrument, or "cli". */
type StepLabel = InstrumentName | "cli";

/**
 * A single subprocess invocation: the program, its arguments, and the working
 * directory to run it in. The cwd is load-bearing: every spawned instrument
 * subprocess must run in THAT instrument's own clone root so its cwd-relative
 * operations (for example `bun link`) act on the right package, not the CLI's.
 */
export interface SpawnInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /**
   * Environment overlay merged OVER the parent's environment for this child.
   * The CLI uses it to hand each child the harness identity (REGIMEN_HARNESS) as
   * an opaque string, without importing any instrument internals; the parent's
   * own environment (including the harness's config-home var, e.g. CODEX_HOME)
   * is forwarded underneath. Absent or empty means "inherit the parent env".
   */
  readonly env?: Record<string, string | undefined>;
}

/** Spawn a subprocess and resolve with its exit code. The injected seam. */
export type SpawnFn = (invocation: SpawnInvocation) => Promise<number>;

export interface StepOutcome {
  /** The instrument name, or "cli" for the CLI's own self-link/unlink step. */
  readonly instrument: InstrumentName | "cli";
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
  /** The CLI's own clone root, the cwd for the CLI self-link/unlink step. */
  readonly cliPackageRoot: string;
  /**
   * When true, the CLI self-link/unlink step is previewed but not spawned: it
   * has no dry-run flag of its own (unlike the instrument steps, which forward
   * --dry-run and self-no-op), so a dry run must skip its real `bun link`.
   */
  readonly dryRun?: boolean;
  /**
   * The environment overlay handed to each INSTRUMENT child (not the CLI
   * self-link step): the harness identity (REGIMEN_HARNESS) as an opaque string,
   * so a child resolves its own harness without the CLI importing any instrument
   * internals or forwarding a --harness flag. The CLI self-link runs `bun link`
   * and needs no harness, so the overlay is not attached to it.
   */
  readonly childEnv?: Record<string, string | undefined>;
}

/**
 * The production spawn adapter: spawn the real subprocess with the parent's
 * current environment, OVERLAID with the invocation's own env (so the CLI can
 * hand a child the harness identity without naming the child's other vars), and
 * with stdout and stderr inherited so a child's output streams to the parent
 * terminal, and resolve with its exit code. Spreading `process.env` explicitly
 * forwards the live environment (Bun.spawn otherwise uses a snapshot taken at
 * process start), so a child sees any environment the parent set after startup;
 * the invocation overlay is spread last so it wins on a key collision. This is
 * the only place that touches Bun.spawn; the runner's control flow never does,
 * which is why it stays deterministically testable through the injected fake.
 */
export function realSpawn(invocation: SpawnInvocation): Promise<number> {
  const proc = Bun.spawn([invocation.command, ...invocation.args], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

/**
 * Resolve one step (instrument or CLI self-link) into its outcome label and the
 * concrete subprocess invocation: an instrument step runs
 * `bun <entryPath> <verb> <...args>` in that instrument's clone root; the CLI
 * step runs `bun <link|unlink>` in the CLI clone root. The cwd is load-bearing
 * in both cases.
 */
function resolveStep(
  step: Step,
  locatedPaths: ReadonlyMap<InstrumentName, string>,
  cloneRoots: ReadonlyMap<InstrumentName, string>,
  cliPackageRoot: string,
  childEnv: Record<string, string | undefined> | undefined,
): { label: StepLabel; verb: string; invocation: SpawnInvocation } {
  if ("kind" in step) {
    return {
      label: "cli",
      verb: step.verb,
      invocation: { command: "bun", args: [step.verb], cwd: cliPackageRoot },
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
      ...(childEnv !== undefined ? { env: childEnv } : {}),
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
      options.cliPackageRoot,
      options.childEnv,
    );
    // The CLI self-link has no dry-run flag of its own; under a dry run it is
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
