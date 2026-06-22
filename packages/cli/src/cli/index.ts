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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, resolveHarnessFromEnvironment } from "@regimen/shared";
import {
  assess as feedbackAssess,
  evidence as feedbackEvidence,
  install as feedbackInstall,
  installableHarnesses as feedbackInstallableHarnesses,
  installScope as feedbackInstallScope,
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
import {
  type InstallMeta,
  type Manifest,
  type ManifestEntry,
  manifestPath,
  readManifest,
  recordInstall,
  recordUninstall,
  writeManifest,
} from "../manifest.ts";

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
    daemon?: boolean;
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

/**
 * The lifecycle seam the install manifest and `regimen update` need (ADR-0012),
 * injected so the manifest write, the per-harness re-install on update, and the
 * daemon cycle are asserted deterministically in a temp data dir without
 * standing up a real OS install. Production binds these to real time, the CLI
 * package version, the current clone's paths, and the feedback facade's scope
 * and harness-set helpers; tests pass fakes that record calls and return fixed
 * stamps. This is the manifest analog of `InstrumentSteps`: the seam is the call
 * itself, and a test asserts what was recorded and what was restamped.
 */
export interface LifecycleDeps {
  /** The current ISO time a fresh install or update stamps. */
  readonly now: () => string;
  /** The Regimen version stamp, read from the CLI package metadata. */
  readonly regimenVersion: () => string;
  /** The current clone root the installed absolute paths are re-resolved from. */
  readonly clonePath: () => string;
  /** The feedback loader entrypoint the daemon service definition points at. */
  readonly loaderPath: () => string;
  /** The install scope a harness lands at: `config-home` or `workspace:<cwd>`. */
  readonly installScope: (harness: string, workspace: string) => string;
  /** The harnesses with a capture descriptor, the `install --all` target set. */
  readonly installableHarnesses: () => string[];
  /** Cycle the daemon so it runs the freshly-resolved loader path (update only). */
  readonly cycleDaemon: (dataDir: string, dryRun: boolean) => number;
}

/** The production lifecycle deps: real time, the package version, the live clone. */
const REAL_LIFECYCLE: LifecycleDeps = {
  now: () => new Date().toISOString(),
  regimenVersion: cliVersion,
  clonePath: monorepoRoot,
  loaderPath: feedbackLoaderPath,
  installScope: feedbackInstallScope,
  installableHarnesses: feedbackInstallableHarnesses,
  cycleDaemon: (dir, dryRun) => feedbackRestart({ dataDir: dir, dryRun }),
};

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
 * Resolve the harnesses a `regimen install` targets: `--all` installs every
 * descriptor-backed harness, `--harnesses <h1> <h2> ...` installs the named
 * subset, and with neither flag the single harness resolved from the environment
 * (`REGIMEN_HARNESS` or a CLI-set marker). The default may be empty when no
 * harness resolves; the per-harness install then fails closed through the
 * facades and nothing is recorded.
 */
function parseHarnessTargets(
  argv: ReadonlyArray<string>,
  life: LifecycleDeps,
): string[] {
  if (argv.includes("--all")) return life.installableHarnesses();
  const named = collectFlagValues(argv, "--harnesses");
  if (named.length > 0) return named;
  const resolved = resolveHarnessFromEnvironment(process.env);
  return resolved === undefined ? [] : [resolved];
}

/** The injected manifest stamps for a fresh install or an update restamp. */
function installMeta(life: LifecycleDeps): InstallMeta {
  return {
    now: life.now(),
    regimenVersion: life.regimenVersion(),
    clonePath: life.clonePath(),
    loaderPath: life.loaderPath(),
  };
}

/**
 * Run the two install pillars for one harness, capture first then the gate (so
 * the capture hook lands ahead of the gate on the pre-tool boundary), with
 * `REGIMEN_HARNESS` set to this harness so the facades resolve exactly it and
 * restored after. The gate pillar always runs (an empty gate set wires no gates
 * but still reconciles the harness hooks file). Fail-fast: a failing capture
 * returns its nonzero code and the gate never runs. This is the one place the
 * per-harness install mechanics live; both `install` and `update` call it, so the
 * env-set dance and the pillar ordering are never duplicated.
 */
function runPillars(
  harness: string,
  dir: string,
  gates: ReadonlyArray<GateId>,
  dryRun: boolean,
  steps: InstrumentSteps,
  daemon: boolean,
): number {
  const saved = process.env.REGIMEN_HARNESS;
  process.env.REGIMEN_HARNESS = harness;
  try {
    const capture = steps.feedbackInstall({
      dataDir: dir,
      dryRun,
      selfLink: false,
      daemon,
    });
    if (capture !== 0) return capture;
    return steps.enforcementInstall({ gates, dryRun });
  } finally {
    if (saved === undefined) delete process.env.REGIMEN_HARNESS;
    else process.env.REGIMEN_HARNESS = saved;
  }
}

/** The manifest scope marking a per-workspace install (Gemini, ADR-0011). */
const WORKSPACE_SCOPE_PREFIX = "workspace:";

/**
 * Install one harness end to end and, on success outside a dry-run, fold the
 * harness, its pillars, and the given install scope into the manifest. The
 * scope is computed by the caller (so it can also drive the per-workspace
 * notice) and recorded verbatim, honoring a harness's per-workspace install. The
 * self-link is the dispatcher's concern, not this per-harness step.
 */
function installHarness(
  harness: string,
  scope: string,
  dir: string,
  gates: ReadonlyArray<GateId>,
  dryRun: boolean,
  steps: InstrumentSteps,
  life: LifecycleDeps,
  manifest: Manifest | undefined,
  daemon: boolean,
): { code: number; manifest: Manifest | undefined } {
  const code = runPillars(harness, dir, gates, dryRun, steps, daemon);
  if (code !== 0 || dryRun) return { code, manifest };

  const pillars = gates.length > 0 ? ["feedback", "enforcement"] : ["feedback"];
  const entry: ManifestEntry = { harness, pillars, scope };
  return {
    code: 0,
    manifest: recordInstall(manifest, entry, installMeta(life)),
  };
}

/**
 * `regimen install`: install each target harness (capture pillar then gate
 * pillar), recording every successful install in the manifest with its pillars
 * and scope, then the one `regimen` self-link last. The default targets the
 * single env-resolved harness; `--all` and `--harnesses` loop the set, with
 * Gemini installing per-workspace (a one-line notice says so). Fail-fast: a
 * failing harness stops the run and returns its nonzero code so a partial install
 * never reports success. Each instrument install runs with `selfLink: false` so
 * only the unified bin is linked. `--no-daemon` threads `daemon: false` to the
 * capture pillar so it wires hooks, skills, and the manifest without registering
 * the loader supervisor, for accounts that cannot create a scheduled task; every
 * other flag still applies.
 */
export function install(
  argv: ReadonlyArray<string>,
  steps: InstrumentSteps = REAL_STEPS,
  life: LifecycleDeps = REAL_LIFECYCLE,
): number {
  const dryRun = argv.includes("--dry-run");
  const daemon = !argv.includes("--no-daemon");
  const dir = dataDir();
  const gates = parseGates(argv);
  const targets = parseHarnessTargets(argv, life);

  process.stdout.write("Regimen install (capture then gates)\n");

  let manifest = readManifest(manifestPath(dir));
  for (const harness of targets) {
    const scope = life.installScope(harness, process.cwd());
    if (scope.startsWith(WORKSPACE_SCOPE_PREFIX)) {
      process.stdout.write(
        `${harness} capture installs into the current workspace only\n`,
      );
    }
    const result = installHarness(
      harness,
      scope,
      dir,
      gates,
      dryRun,
      steps,
      life,
      manifest,
      daemon,
    );
    if (result.code !== 0) return result.code;
    manifest = result.manifest;
  }

  const link = steps.selfLink("link", dryRun);
  if (link !== 0) {
    process.stderr.write("failed to link the regimen CLI onto PATH\n");
    return link;
  }

  if (!dryRun && manifest !== undefined) {
    writeManifest(manifestPath(dir), manifest);
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
 * `selfLink: false`. Outside a dry-run it removes the env-resolved harness from
 * the install manifest so `regimen status` no longer reports it installed.
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

  if (!dryRun) {
    const harness = resolveHarnessFromEnvironment(process.env);
    const manifest = readManifest(manifestPath(dir));
    if (harness !== undefined && manifest !== undefined) {
      writeManifest(manifestPath(dir), recordUninstall(manifest, harness));
    }
  }

  process.stdout.write(
    dryRun
      ? "dry run complete; nothing was changed\n"
      : "Regimen uninstalled\n",
  );
  return failed;
}

/**
 * `regimen update`: re-apply the recorded install from the CURRENT clone so a
 * moved or upgraded clone rewrites the absolute paths baked into the installed
 * hooks, gates, and service definition (ADR-0012). It reads the manifest and,
 * for each recorded entry, re-runs the idempotent per-harness install honoring
 * that entry's scope (including Gemini's recorded workspace), cycles the daemon
 * so the supervisor runs the freshly-resolved loader path, then restamps the
 * version, the update time, and the re-resolved clone and loader paths. With no
 * manifest present it cannot know what to update, so it falls back to behaving
 * like a fresh `regimen install`.
 */
export function update(
  argv: ReadonlyArray<string>,
  steps: InstrumentSteps = REAL_STEPS,
  life: LifecycleDeps = REAL_LIFECYCLE,
): number {
  const dir = dataDir();
  const existing = readManifest(manifestPath(dir));
  if (existing === undefined) {
    process.stdout.write(
      "no install manifest found; running a fresh install\n",
    );
    return install(argv, steps, life);
  }

  const dryRun = argv.includes("--dry-run");
  process.stdout.write("Regimen update (re-applying recorded installs)\n");

  const meta = installMeta(life);
  const updated: Manifest = {
    ...existing,
    regimenVersion: meta.regimenVersion,
    clonePath: meta.clonePath,
    loaderPath: meta.loaderPath,
    updatedAt: meta.now,
  };

  for (const entry of existing.entries) {
    const gates = entry.pillars.includes("enforcement")
      ? [...DEFAULT_GATES]
      : [];
    const code = runPillars(entry.harness, dir, gates, dryRun, steps, true);
    if (code !== 0) return code;
  }

  const cycle = life.cycleDaemon(dir, dryRun);
  if (cycle !== 0) {
    process.stderr.write("failed to cycle the daemon after update\n");
    return cycle;
  }

  if (!dryRun) writeManifest(manifestPath(dir), updated);

  process.stdout.write(
    dryRun ? "dry run complete; nothing was changed\n" : "Regimen updated\n",
  );
  return 0;
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
  // --judge-via forces the judge backend; only the two known values pass
  // through, an unknown value falls through to the facade's auto-selection.
  const judgeViaRaw = flagValue(argv, "--judge-via");
  const judgeVia =
    judgeViaRaw === "cli" || judgeViaRaw === "api" ? judgeViaRaw : undefined;
  return feedbackAssess({
    dataDir: dataDir(),
    ...(session === undefined ? {} : { session }),
    ...(judgeModel === undefined ? {} : { judgeModel }),
    ...(judgeVia === undefined ? {} : { judgeVia }),
  });
}

/**
 * `regimen status`: surface what is installed (the manifest's version and
 * per-harness entries with pillars and scope, plus the install and update
 * timestamps) composed with the feedback program status (enabled state and
 * daemon liveness) the dispatcher already owns. With no manifest it says plainly
 * that nothing is installed yet.
 */
function status(): number {
  const dir = dataDir();
  const manifest = readManifest(manifestPath(dir));
  if (manifest === undefined) {
    process.stdout.write("nothing installed yet (no install manifest)\n");
  } else {
    process.stdout.write(`installed: regimen ${manifest.regimenVersion}\n`);
    process.stdout.write(
      `  installed ${manifest.installedAt}, updated ${manifest.updatedAt}\n`,
    );
    for (const entry of manifest.entries) {
      process.stdout.write(
        `  ${entry.harness}: ${entry.pillars.join(", ")} (${entry.scope})\n`,
      );
    }
  }
  return feedbackStatus({ dataDir: dir });
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

/** The single source-of-truth usage text, shared by help (stdout) and bare/unknown (stderr). */
export function usage(): string {
  return `regimen <command> [flags]

Lifecycle:
  install [--all | --harnesses <h...>]   install Regimen (capture, gates, skills) for the harness(es)
  update                                 re-resolve paths, re-run recorded installs, cycle the daemon, restamp
  uninstall                              remove Regimen for the current harness
  status                                 installed version, harnesses + scopes, and daemon health

Daemon:
  daemon start|stop|restart|status       control or inspect the capture daemon

Read & judge:
  evidence                               quantitative digest of the current session (free, deterministic)
  assess                                 judged verdict of the current session (paid LLM call, writes a verdict)
  list [--harness <h>] [--since <when>] [--json]   enumerate captured sessions

Flags:
  --dry-run                       preview without changing anything
  --gate <name> | --no-gates      select enforcement gates (install)
  --no-daemon                     install capture without the loader daemon (install)

The harness is auto-detected per invocation, or set REGIMEN_HARNESS.
`;
}

/**
 * Parse argv and dispatch to the owning facade in-process. argv is the program's
 * arguments with the node/script prefix already stripped (so the subcommand is
 * at index 0). Returns the process exit code; an unknown command fails closed.
 */
export function runCli(argv: ReadonlyArray<string>): number | Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    process.stderr.write(usage());
    return 1;
  }
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(usage());
      return 0;
    case "install":
      return install(argv);
    case "update":
      return update(argv);
    case "uninstall":
      return uninstall(argv);
    case "status":
      return status();
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
      process.stderr.write(usage());
      return 1;
  }
}

/** The cli package's own root, two levels up from this file. */
export function cliPackageRoot(): string {
  return dirname(dirname(import.meta.dir));
}

/**
 * The monorepo clone root the install bakes absolute paths against: the parent
 * of the cli package (`packages/cli` -> the workspace root). `regimen update`
 * re-resolves this from the current clone so a moved or upgraded clone rewrites
 * the paths baked into the installed hooks, gates, and service definition.
 */
export function monorepoRoot(): string {
  return dirname(cliPackageRoot());
}

/**
 * The feedback loader entrypoint the daemon service definition runs, resolved
 * from the current clone the same way the feedback facade resolves it
 * (`packages/feedback/src/loader/run.ts`). Recorded in the manifest so an
 * update re-points the supervisor at the current clone's loader.
 */
export function feedbackLoaderPath(): string {
  return join(
    monorepoRoot(),
    "packages",
    "feedback",
    "src",
    "loader",
    "run.ts",
  );
}

/** The Regimen version stamp, read from the CLI package's own `package.json`. */
export function cliVersion(): string {
  const raw = readFileSync(join(cliPackageRoot(), "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
