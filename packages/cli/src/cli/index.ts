#!/usr/bin/env bun
/**
 * The unified `regimen` CLI: the one composition root and the one argv parser
 * (ADR-0012). It imports `@regimen/feedback` and `@regimen/enforcement` as
 * in-process libraries and calls their typed command functions directly, rather
 * than spawning their CLIs as subprocesses. It stays deliberately shallow: it
 * parses argv, resolves the data dir once, dispatches each subcommand to the
 * owning package's facade, and holds a single exit contract. The depth lives in
 * the facades it calls.
 *
 * The command surface is grouped by user task, not by instrument (the pillar
 * nouns Feedback and Enforcement leave the command line). Lifecycle is flat:
 * `regimen install` / `uninstall` / `status`. The read-and-judge primitives are
 * flat: `regimen assess` / `evidence` / `list`. The daemon supervisor is grouped
 * so its `start`/`status` do not collide with the program-level verbs:
 * `regimen daemon start|stop|restart|status`. The old wiring verbs (wire-hooks,
 * wire-gates, install-daemon, install-skill) are internal steps of
 * `regimen install`, no longer user verbs.
 *
 * `regimen install` composes the per-instrument installs in order so the capture
 * hook lands ahead of the gate on the pre-tool boundary (feedback then
 * enforcement); `uninstall` is the reverse (gates down before capture). The
 * single `regimen` self-link is owned here: each instrument install runs with
 * `selfLink: false` so only one `regimen` bin is linked, not a per-instrument
 * one. The harness-invoked scripts (capture hooks, gate scripts, the loader
 * daemon) stay standalone and absolute-path-invoked; this collapse touches only
 * the user-facing command layer.
 */
import { dirname } from "node:path";
import { dataDir } from "@regimen/shared";
import {
  assess as feedbackAssess,
  evidence as feedbackEvidence,
  install as feedbackInstall,
  list as feedbackList,
  restart as feedbackRestart,
  type SessionFilter,
  start as feedbackStart,
  status as feedbackStatus,
  stop as feedbackStop,
  uninstall as feedbackUninstall,
} from "@regimen/feedback";
import {
  type GateId,
  install as enforcementInstall,
  uninstall as enforcementUninstall,
} from "@regimen/enforcement";

/**
 * The instrument install/uninstall steps the orchestrator composes, injected so
 * the ordering and fail-fast/best-effort control flow is tested deterministically
 * without standing up a real install. Production binds these to the in-process
 * facades; tests pass recording fakes. This is the in-process analog of the
 * deleted runner's spawn seam: there is no subprocess to fake, so the seam is the
 * call itself, and a test asserts call order plus exit aggregation (ADR-0012).
 */
export interface InstrumentSteps {
  readonly feedbackInstall: (options: {
    dataDir: string;
    dryRun: boolean;
    selfLink?: boolean;
  }) => number;
  readonly enforcementInstall: (options: {
    gates: ReadonlyArray<GateId>;
    dryRun: boolean;
  }) => number;
  readonly feedbackUninstall: (options: {
    dataDir: string;
    dryRun: boolean;
    selfLink?: boolean;
  }) => number;
  readonly enforcementUninstall: (options: { dryRun: boolean }) => number;
  /** The one `regimen` self-link (`bun link`/`bun unlink` at the cli root). */
  readonly selfLink: (verb: "link" | "unlink", dryRun: boolean) => number;
}

/** The production steps: the in-process facades plus the real `regimen` self-link. */
const REAL_STEPS: InstrumentSteps = {
  feedbackInstall,
  enforcementInstall,
  feedbackUninstall,
  enforcementUninstall,
  selfLink: realSelfLink,
};

/** The default gate set wired by `regimen install` (all three). */
const DEFAULT_GATES: ReadonlyArray<GateId> = [
  "rm-rf",
  "em-dash",
  "inline-message",
];

/** The value following `flag` in `argv`, or undefined if absent or last. */
function flagValue(
  argv: ReadonlyArray<string>,
  flag: string,
): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/** Every value following a repeatable flag, in order. */
function collectFlagValues(
  argv: ReadonlyArray<string>,
  flag: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  }
  return out;
}

/** The gate set `regimen install` wires: `--no-gates` for none, `--gate <id>` to override, else all three. */
function parseGates(argv: ReadonlyArray<string>): GateId[] {
  if (argv.includes("--no-gates")) return [];
  const explicit = collectFlagValues(argv, "--gate");
  return explicit.length > 0 ? (explicit as GateId[]) : [...DEFAULT_GATES];
}

/** Project one `--flag value` pair onto a single-key partial of SessionFilter. */
function optionalFilter(
  argv: ReadonlyArray<string>,
  flag: string,
  key: keyof SessionFilter,
): Partial<SessionFilter> {
  const value = flagValue(argv, flag);
  return value === undefined ? {} : { [key]: value };
}

/**
 * `regimen install`: install the capture pillar first, then the gate pillar, so
 * the capture hook lands ahead of the gate on the pre-tool boundary (a denied
 * tool call is still captured). Fail-fast: a failing step stops the run and
 * returns its nonzero code, so a partial install never reports success. The one
 * `regimen` self-link runs last; each instrument install runs with
 * `selfLink: false` so only the unified bin is linked.
 */
export function install(
  argv: ReadonlyArray<string>,
  steps: InstrumentSteps = REAL_STEPS,
): number {
  const dryRun = argv.includes("--dry-run");
  const dir = dataDir();
  const gates = parseGates(argv);

  process.stdout.write("Regimen install (capture then gates)\n");

  const capture = steps.feedbackInstall({
    dataDir: dir,
    dryRun,
    selfLink: false,
  });
  if (capture !== 0) return capture;

  const gate = steps.enforcementInstall({ gates, dryRun });
  if (gate !== 0) return gate;

  const link = steps.selfLink("link", dryRun);
  if (link !== 0) {
    process.stderr.write("failed to link the regimen CLI onto PATH\n");
    return link;
  }

  process.stdout.write(
    dryRun
      ? "dry run complete; nothing was changed\n"
      : "Regimen installed; run `regimen status` to confirm the daemon is live\n",
  );
  return 0;
}

/**
 * `regimen uninstall`: tear down in reverse (gates before capture). Best effort:
 * every step runs even if an earlier one failed, so a half-installed system can
 * always be cleaned up; the aggregate exit is nonzero if any step failed. The one
 * `regimen` self-unlink runs last; each instrument teardown runs with
 * `selfLink: false`.
 */
export function uninstall(
  argv: ReadonlyArray<string>,
  steps: InstrumentSteps = REAL_STEPS,
): number {
  const dryRun = argv.includes("--dry-run");
  const dir = dataDir();
  let failed = 0;

  process.stdout.write("Regimen uninstall (gates then capture)\n");

  if (steps.enforcementUninstall({ dryRun }) !== 0) failed = 1;
  if (
    steps.feedbackUninstall({ dataDir: dir, dryRun, selfLink: false }) !== 0
  ) {
    failed = 1;
  }

  if (steps.selfLink("unlink", dryRun) !== 0) {
    process.stderr.write("failed to unlink the regimen CLI\n");
    failed = 1;
  }

  process.stdout.write(
    dryRun
      ? "dry run complete; nothing was changed\n"
      : "Regimen uninstalled\n",
  );
  return failed;
}

/**
 * Run the one `regimen` self-link as a `bun link`/`bun unlink` at the cli package
 * root, or preview it under `--dry-run`. The cwd is the cli clone root so the
 * link acts on the `regimen` bin, not the caller's package. This is the single
 * self-link the install/uninstall orchestration owns; the per-instrument facades
 * run with `selfLink: false` so only one bin is ever linked.
 */
function realSelfLink(verb: "link" | "unlink", dryRun: boolean): number {
  if (dryRun) {
    process.stdout.write(`would run: bun ${verb} (cwd ${cliPackageRoot()})\n`);
    return 0;
  }
  process.stdout.write(`running: bun ${verb}\n`);
  const proc = Bun.spawnSync({
    cmd: ["bun", verb],
    cwd: cliPackageRoot(),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    process.stderr.write(
      `command failed (exit ${proc.exitCode}): bun ${verb}\n`,
    );
    return proc.exitCode ?? 1;
  }
  return 0;
}

/** Dispatch the grouped `regimen daemon <verb>` to the feedback lifecycle facade. */
function daemon(argv: ReadonlyArray<string>): number | Promise<number> {
  const verb = argv[1];
  const dir = dataDir();
  const dryRun = argv.includes("--dry-run");
  if (verb === "start") return feedbackStart({ dataDir: dir, dryRun });
  if (verb === "stop") return feedbackStop({ dataDir: dir, dryRun });
  if (verb === "restart") return feedbackRestart({ dataDir: dir, dryRun });
  if (verb === "status") return feedbackStatus({ dataDir: dir });
  process.stderr.write("usage: regimen daemon <start|stop|restart|status>\n");
  return 1;
}

/** Dispatch `regimen evidence` to the feedback evidence facade. */
function evidence(argv: ReadonlyArray<string>): number {
  const session = flagValue(argv, "--session");
  return feedbackEvidence({
    dataDir: dataDir(),
    ...(session === undefined ? {} : { session }),
  });
}

/** Dispatch `regimen assess` to the feedback assess facade. */
function assess(argv: ReadonlyArray<string>): Promise<number> {
  const session = flagValue(argv, "--session");
  const judgeModel = flagValue(argv, "--judge-model");
  return feedbackAssess({
    dataDir: dataDir(),
    ...(session === undefined ? {} : { session }),
    ...(judgeModel === undefined ? {} : { judgeModel }),
  });
}

/** Dispatch `regimen list` to the feedback list facade. */
function list(argv: ReadonlyArray<string>): number {
  const filter: SessionFilter = {
    ...optionalFilter(argv, "--harness", "harness"),
    ...optionalFilter(argv, "--model", "model"),
    ...optionalFilter(argv, "--since", "since"),
    ...optionalFilter(argv, "--until", "until"),
    ...optionalFilter(argv, "--outcome", "outcome"),
  };
  return feedbackList({
    dataDir: dataDir(),
    filter,
    asJson: argv.includes("--json"),
  });
}

/**
 * Parse argv and dispatch to the owning facade in-process. argv is the program's
 * arguments with the node/script prefix already stripped (so the subcommand is
 * at index 0). Returns the process exit code; an unknown command fails closed.
 */
export function runCli(argv: ReadonlyArray<string>): number | Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    process.stderr.write(
      "usage: regimen <install|uninstall|status|daemon|assess|evidence|list>\n",
    );
    return 1;
  }
  switch (command) {
    case "install":
      return install(argv);
    case "uninstall":
      return uninstall(argv);
    case "status":
      return feedbackStatus({ dataDir: dataDir() });
    case "daemon":
      return daemon(argv);
    case "assess":
      return assess(argv);
    case "evidence":
      return evidence(argv);
    case "list":
      return list(argv);
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      return 1;
  }
}

/** The cli package's own root, two levels up from this file. */
export function cliPackageRoot(): string {
  return dirname(dirname(import.meta.dir));
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
