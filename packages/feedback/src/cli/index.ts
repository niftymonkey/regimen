/**
 * The Feedback command facade: each command is an exported library function
 * taking a typed, already-parsed options object, the surface the unified
 * `regimen` CLI dispatches to in-process (ADR-0012). The dispatcher owns argv
 * parsing; these functions own the work.
 *
 * Commands per ADR-0006:
 *   start            set the enabled flag and, if a service is installed,
 *                    start the daemon via the platform supervisor
 *   stop             clear the enabled flag and, if a service is installed,
 *                    stop the daemon via the platform supervisor
 *   restart          delegate to the supervisor's restart so the replacement
 *                    process runs current code (service installed only)
 *   status           report enabled state, daemon liveness, freshness, backlog
 *   installDaemon    write the OS-specific user-level service definition
 *   uninstallDaemon  remove that service definition
 *   installSkill     copy the bundled skills into the harness's skills dir
 *   purge            discard the buffer, and with --all the store and logs too
 *   evidence         print one conversation's evidence-layer digest as JSON
 *   list             enumerate sessions by harness, model, time window, outcome
 *   wireHooks        merge the capture hook into the harness hooks file
 *   unwireHooks      remove the capture hook
 *   install          stand up the Feedback pillar (capture + daemon + skills)
 *   uninstall        tear it down in reverse (best effort)
 *
 * The lifecycle commands are supervisor-aware. The enabled flag stays the
 * single capture-and-storage privacy gate (ADR-0006): supervision controls the
 * process, the flag controls whether anything is captured, and the two are kept
 * separate. When no service is installed the commands keep flag-only semantics
 * but say so honestly: `start` states that no daemon was launched and how to
 * run one foreground (`bun src/loader/run.ts`), and `restart` refuses to claim
 * a cycle it cannot perform. A lifecycle command that cannot verify its effect
 * fails loudly (nonzero exit plus a reason) rather than printing success.
 */
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  HARNESS_DESCRIPTORS,
  type HarnessDescriptor,
} from "../harness/descriptor.ts";
import { harnessSupport, type HarnessSupport } from "../harness/support.ts";
import {
  bufferDir,
  type Harness,
  planSkillInstall,
  resolveHarnessFromEnvironment,
  resolveHarnessHome,
} from "@regimen/shared";
import { clearEnabled, isEnabled, setEnabled } from "../enabled-flag.ts";
import { readEvidenceDigest, unknownDigest } from "../evidence.ts";
import {
  countUnassessed,
  listSessions,
  resolveSessionId,
  type SessionFilter,
  type SessionSummary,
} from "../sessions.ts";
import { openStore } from "../store.ts";
import { assessConversation } from "../judged/assess.ts";
import {
  emitPrompt as agentEmitPrompt,
  recordVerdict as agentRecordVerdict,
  type RecordEnvelope,
} from "../judged/agent-seam.ts";
import { resolveJudgeModel } from "../judged/resolve.ts";
import { createLiveSetupSource } from "../judged/live-setup-source.ts";
import type { SetupSource } from "../judged/setup.ts";
import type { JudgeModelPort } from "../judged/port.ts";
import {
  calibrateSessions,
  formatCalibration,
  type CalibrateTarget,
  type CalibrationMode,
} from "../judged/calibrate.ts";
import {
  goldenPath,
  readGolden,
  writeGolden,
  type GoldenEntry,
} from "../judged/golden.ts";
import { sessionHarnessModel } from "../judged/slice.ts";
import {
  rollupHeader,
  rollupVerdicts,
  type VerdictRollup,
} from "../judged/rollup.ts";
import { leverageAudit, type AuditFilter } from "../judged/audit.ts";
import { synthesizeAudit } from "../judged/audit-synthesis.ts";
import {
  runSweep,
  selectSessionsToJudge,
  type BatchDecision,
  type SweepOutcome,
} from "../judged/sweep.ts";
import { TranscriptNotFoundError } from "../judged/read-conversation.ts";
import {
  planInstall,
  serviceFileBytes,
  type InstallPlan,
} from "./install/index.ts";
import {
  type HooksFile,
  planCaptureHooks,
  planCaptureHooksRemoval,
  type VersionedHooksFile,
  type WireChange,
} from "./install/capture-hooks.ts";
import { waitForDaemonAlive } from "./wait-for-daemon.ts";

export type { SessionFilter, SessionSummary } from "../sessions.ts";
export type { BatchDecision } from "../judged/sweep.ts";
export type { AuditFilter } from "../judged/audit.ts";

/** How to run the daemon foreground when no supervisor is installed. */
const FOREGROUND_HINT =
  "no daemon was launched; install a supervisor with `feedback install-daemon`, or run one foreground with `bun src/loader/run.ts`";

/**
 * The one line the install prints when `--no-daemon` skips the daemon step (a
 * non-admin account that cannot register a scheduled task, ADR follow-up). It
 * states plainly that the loader is not running and how to drain the buffer by
 * hand from the clone root, so capture wiring still completing is never mistaken
 * for a live daemon.
 */
const DAEMON_SKIPPED_NOTICE =
  "daemon skipped (--no-daemon); the loader is not running. Drain the buffer yourself by running: bun packages/feedback/src/loader/run.ts";

/**
 * The fail-closed message when no harness can be resolved from the environment.
 * A harness is resolved from `REGIMEN_HARNESS` or a CLI-set marker env var; with
 * neither present the command refuses rather than guessing one.
 */
const NO_HARNESS =
  "could not determine the harness: set REGIMEN_HARNESS or run inside a supported agent CLI";

interface Lifecycle {
  readonly plan: InstallPlan;
  /** True when a service definition exists for this platform under this HOME. */
  readonly serviceInstalled: boolean;
}

/**
 * Build the install plan for the running platform and decide whether a service
 * is installed, by statting the plan's `serviceInstalledPath`. Returns null
 * (after writing a stderr reason) when the environment cannot be resolved, so
 * the caller fails loudly rather than guessing. The stat is the only side
 * effect; the plan itself is pure data from `planInstall`.
 */
function resolveLifecycle(dir: string): Lifecycle | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return null;
  }
  const ctx = {
    bunPath: process.execPath,
    loaderPath: resolve(import.meta.dir, "..", "loader", "run.ts"),
    dataDir: dir,
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
  };
  let plan: InstallPlan;
  try {
    plan = planInstall(ctx, process.platform, home);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return null;
  }
  return { plan, serviceInstalled: existsSync(plan.serviceInstalledPath) };
}

/**
 * Run a supervisor command list, or under `dryRun` print what would run and
 * execute nothing. Returns the first nonzero exit code so the caller can fail
 * loudly; 0 means every command (or the dry-run preview) succeeded. Callers
 * return early after a dry-run so they never print an actual-success line for
 * a supervisor action that did not run.
 */
function runLifecycleCommands(
  commands: ReadonlyArray<ReadonlyArray<string>>,
  dryRun: boolean,
): number {
  if (dryRun) {
    for (const cmd of commands) {
      process.stdout.write(`would run: ${cmd.join(" ")}\n`);
    }
    return 0;
  }
  return runCommands(commands);
}

/**
 * How long a supervised start or restart waits for the daemon to become live
 * before failing loudly, and how often it re-probes.
 */
const DAEMON_READY_TIMEOUT_MS = 5000;
const DAEMON_READY_POLL_MS = 100;

/**
 * After a supervisor accepts a start or restart, confirm the daemon actually
 * became live (its pid file present and the process answering signal 0) before
 * the caller reports success. The supervisor returns on the bare process
 * hand-off, so this closes the window where `feedback status` would briefly
 * read "not running" right after a reported success, and the case where a
 * loader that execs and then crashes on startup would still look started.
 */
function daemonBecameLive(dir: string): boolean {
  return waitForDaemonAlive(
    () => {
      const daemon = readStatus(dir).daemon;
      return daemon !== "not_running" && daemon.alive;
    },
    { timeoutMs: DAEMON_READY_TIMEOUT_MS, pollMs: DAEMON_READY_POLL_MS },
  );
}

/**
 * `feedback start`. Outside a dry-run the enabled flag (the capture-and-storage
 * gate, ADR-0006) is set first; a `--dry-run` previews only and writes nothing,
 * so the gate is never flipped by a preview. With a service installed, the
 * platform supervisor is then asked to start the daemon, and a supervisor
 * failure fails the command loudly. With no service installed, the flag-only
 * semantics stand but the output says plainly that no daemon was launched and
 * how to run one, so nothing implies a daemon is now running.
 */
export function start(options: { dataDir: string; dryRun: boolean }): number {
  const { dataDir: dir, dryRun } = options;
  const lifecycle = resolveLifecycle(dir);
  if (lifecycle === null) return 1;
  const alreadyEnabled = isEnabled(dir);
  if (!alreadyEnabled && !dryRun) setEnabled(dir);

  if (!lifecycle.serviceInstalled) {
    if (dryRun) {
      process.stdout.write(
        alreadyEnabled
          ? "feedback is already enabled\n"
          : "would enable feedback\n",
      );
    } else {
      process.stdout.write(
        alreadyEnabled
          ? "feedback was already enabled\n"
          : "feedback enabled\n",
      );
    }
    process.stdout.write(`${FOREGROUND_HINT}\n`);
    return 0;
  }

  const code = runLifecycleCommands(lifecycle.plan.startCommands, dryRun);
  if (code !== 0) {
    process.stderr.write("failed to start the daemon via the supervisor\n");
    return code;
  }
  if (dryRun) return 0;
  if (!daemonBecameLive(dir)) {
    process.stderr.write(
      "the supervisor accepted the start, but the daemon did not become live in time\n",
    );
    return 1;
  }
  process.stdout.write("feedback enabled; daemon started via the supervisor\n");
  return 0;
}

/**
 * `feedback stop`. Outside a dry-run it clears the enabled flag (capture and
 * storage stop per ADR-0006); a `--dry-run` previews only and leaves capture
 * running. With a service installed it then asks the supervisor to stop the
 * daemon and fails loudly if that command fails. With no service installed, a
 * manually-run daemon polls the flag and self-exits within a poll interval; the
 * output says so rather than implying an immediate stop.
 */
export function stop(options: { dataDir: string; dryRun: boolean }): number {
  const { dataDir: dir, dryRun } = options;
  const lifecycle = resolveLifecycle(dir);
  if (lifecycle === null) return 1;
  const wasEnabled = isEnabled(dir);
  if (wasEnabled && !dryRun) clearEnabled(dir);

  if (!lifecycle.serviceInstalled) {
    if (dryRun) {
      process.stdout.write(
        wasEnabled
          ? "would disable feedback\n"
          : "feedback is already disabled\n",
      );
    } else {
      process.stdout.write(
        wasEnabled ? "feedback disabled\n" : "feedback was already disabled\n",
      );
    }
    process.stdout.write(
      "any manually-run daemon will self-exit within one flag-poll interval\n",
    );
    return 0;
  }

  const code = runLifecycleCommands(lifecycle.plan.stopCommands, dryRun);
  if (code !== 0) {
    process.stderr.write("failed to stop the daemon via the supervisor\n");
    return code;
  }
  if (dryRun) return 0;
  process.stdout.write(
    "feedback disabled; daemon stopped via the supervisor\n",
  );
  return 0;
}

/**
 * `feedback restart`. With a service installed, this delegates to the
 * supervisor's own restart so the replacement process runs current code; the
 * enabled flag stays set throughout (a restart implies enabled), and a
 * supervisor failure fails loudly. A `--dry-run` previews the supervisor
 * command and writes nothing, so the enabled flag is never set by a preview.
 * An empty restart command list means the
 * platform cannot express a supervisor restart here (macOS without a resolved
 * uid), which fails loudly rather than silently doing nothing.
 *
 * With no service installed, the old clear-then-set was the reported bug: the
 * disabled window was too brief for the loader's flag poll to observe, so the
 * daemon never cycled while the CLI printed success. Restart cannot relaunch a
 * manually-run daemon, so when one is detected alive it fails loudly with the
 * stop-then-start instructions instead of pretending to have cycled it; with
 * no daemon running it just ensures the flag is set and points at how to run
 * one.
 */
export function restart(options: { dataDir: string; dryRun: boolean }): number {
  const { dataDir: dir, dryRun } = options;
  const lifecycle = resolveLifecycle(dir);
  if (lifecycle === null) return 1;

  if (!lifecycle.serviceInstalled) {
    const daemon = readStatus(dir).daemon;
    if (daemon !== "not_running" && daemon.alive) {
      process.stderr.write(
        `a manually-run daemon (pid ${daemon.pid}) cannot be restarted in place; run \`feedback stop\`, wait for it to exit, then \`feedback start\` and relaunch it\n`,
      );
      return 1;
    }
    const alreadyEnabled = isEnabled(dir);
    if (!alreadyEnabled && !dryRun) setEnabled(dir);
    if (dryRun) {
      process.stdout.write(
        alreadyEnabled
          ? "feedback is already enabled\n"
          : "would enable feedback\n",
      );
    } else {
      process.stdout.write(
        alreadyEnabled
          ? "feedback was already enabled\n"
          : "feedback enabled\n",
      );
    }
    process.stdout.write(`${FOREGROUND_HINT}\n`);
    return 0;
  }

  if (lifecycle.plan.restartCommands.length === 0) {
    process.stderr.write(
      "cannot restart the daemon via the supervisor on this platform; run `feedback stop` then `feedback start`\n",
    );
    return 1;
  }
  if (!isEnabled(dir) && !dryRun) setEnabled(dir);
  const code = runLifecycleCommands(lifecycle.plan.restartCommands, dryRun);
  if (code !== 0) {
    process.stderr.write("failed to restart the daemon via the supervisor\n");
    return code;
  }
  if (dryRun) return 0;
  if (!daemonBecameLive(dir)) {
    process.stderr.write(
      "the supervisor accepted the restart, but the daemon did not become live in time\n",
    );
    return 1;
  }
  process.stdout.write(
    "feedback restarted; daemon cycled via the supervisor\n",
  );
  return 0;
}

/**
 * Discard the buffer so a new session starts from a clean slate. The SQLite
 * store is the source of truth for what was already captured, so dropping
 * the buffer is always safe; `--all` additionally drops the store itself
 * (and its WAL sidecars) and the daemon's operational logs for a full reset.
 * A purge while the daemon is running would race its writes, so it refuses
 * unless `force` is set.
 */
export function status(options: { dataDir: string }): number {
  process.stdout.write(formatStatus(readStatus(options.dataDir)));
  return 0;
}

export function purge(options: {
  dataDir: string;
  all: boolean;
  force: boolean;
}): number {
  const { dataDir: dir, all: includeStore, force } = options;
  const daemon = readStatus(dir).daemon;
  if (!force && daemon !== "not_running" && daemon.alive) {
    process.stderr.write(
      `the daemon is running (pid ${daemon.pid}); run \`feedback stop\` first, or pass --force\n`,
    );
    return 1;
  }
  const buf = bufferDir(dir);
  rmSync(buf, { recursive: true, force: true });
  mkdirSync(buf, { recursive: true });
  process.stdout.write("buffer purged\n");
  if (includeStore) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, `feedback.db${suffix}`), { force: true });
    }
    process.stdout.write("store purged\n");
    purgeLogs(dir);
  }
  return 0;
}

/**
 * Remove the daemon's operational logs and their rolled copies. Called only
 * under `purge --all`: the logs are operational diagnostics rather than
 * captured data, so an ordinary buffer purge leaves them in place.
 */
function purgeLogs(dir: string): void {
  const isLog = (name: string): boolean =>
    name === "daemon.log" ||
    name === "capture-errors.log" ||
    /^daemon\.log\.\d+$/.test(name) ||
    /^capture-errors\.log\.\d+$/.test(name);
  for (const name of readdirSync(dir)) {
    if (isLog(name)) rmSync(join(dir, name), { force: true });
  }
  process.stdout.write("logs purged\n");
}

/**
 * Print the evidence-layer digest for one conversation as JSON on stdout, so
 * the in-session evidence skill can read it back into the agent's context.
 * Reads the SQLite store directly; no daemon and no network are involved.
 *
 * The session is identified one of two ways: `--session <id>` is the generic,
 * harness-agnostic form a harness that exposes a session id to the agent's shell
 * can pass, while otherwise the harness is resolved from the environment
 * (`REGIMEN_HARNESS` or a CLI-set marker) and its current session is resolved
 * from the local filesystem, for harnesses that expose no session-id to the
 * agent's shell. Resolution is the only harness-specific step; the digest itself
 * is the same for every harness.
 */
export function evidence(options: {
  dataDir: string;
  session?: string;
}): number {
  const { dataDir: dir, session: explicit } = options;
  if (explicit !== undefined) return printEvidence(dir, explicit);

  let harness;
  try {
    harness = resolveHarnessFromEnvironment(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  const support = harness ? harnessSupport(harness) : undefined;
  if (harness === undefined || support === undefined) {
    process.stderr.write(
      `${harness === undefined ? NO_HARNESS : `unsupported harness: ${harness}`}\n`,
    );
    return 1;
  }
  const envVar = support.descriptor.contract.configHome.envVar;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined && process.env[envVar] === undefined) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return 1;
  }
  const harnessHome = resolveHarnessHome(
    support.descriptor.contract,
    process.env,
    home ?? "",
  );
  const resolved = support.resolver.resolveCurrent({
    dataDir: dir,
    harnessHome,
    cwd: process.cwd(),
  });
  if (resolved === null) {
    process.stdout.write(
      `${JSON.stringify(unknownDigest("", Date.now, `could not resolve the current ${harness} session id`))}\n`,
    );
    return 0;
  }
  return printEvidence(dir, resolved);
}

/** Read one session's digest from the store and print it as JSON. */
function printEvidence(dir: string, sessionId: string): number {
  const storePath = join(dir, "feedback.db");
  if (!existsSync(storePath)) {
    process.stdout.write(`${JSON.stringify(unknownDigest(sessionId))}\n`);
    return 0;
  }
  const db = new Database(storePath, { readonly: true });
  try {
    process.stdout.write(
      `${JSON.stringify(readEvidenceDigest(db, sessionId))}\n`,
    );
  } finally {
    db.close();
  }
  return 0;
}

/** A harness's resolved on-disk location for the judge path. */
interface HarnessLocation {
  readonly support: HarnessSupport;
  readonly harnessHome: string;
  readonly sessionsDir: string;
}

/**
 * Resolve where a known harness keeps its transcripts: its support registry
 * entry, its config home (the contract env-var override or the user's home), and
 * the transcripts directory under that home. Throws a clear Error when the
 * harness is unsupported or no home is set, so the single-session and sweep
 * callers both land on their stderr-plus-exit path. `harness` is a plain string
 * because the sweep hands it conversation harnesses straight from the store; an
 * unregistered one resolves to undefined support and the unsupported throw.
 */
function resolveHarnessLocation(
  harness: string,
  env: NodeJS.ProcessEnv,
): HarnessLocation {
  const support = harnessSupport(harness as Harness);
  if (support === undefined) {
    throw new Error(`unsupported harness: ${harness}`);
  }
  const envVar = support.descriptor.contract.configHome.envVar;
  // Treat an empty HOME, USERPROFILE, or config-home override as unset so the
  // resolver fails closed instead of resolving a relative directory.
  const override = env[envVar];
  const home = [env.HOME, env.USERPROFILE].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const hasOverride = typeof override === "string" && override.length > 0;
  if (home === undefined && !hasOverride) {
    throw new Error("HOME (or USERPROFILE on Windows) is not set");
  }
  const harnessHome = resolveHarnessHome(
    support.descriptor.contract,
    env,
    home ?? "",
  );
  const sessionsDir = join(harnessHome, support.descriptor.transcriptsSubdir);
  return { support, harnessHome, sessionsDir };
}

/**
 * Run one `feedback assess` pass over a conversation and print its JudgmentDigest
 * as JSON on stdout (the judged twin of `feedback evidence`). Unlike evidence,
 * assess writes the store (events + verdict), so it opens read-write and locates
 * the transcript under the harness's transcripts subdir of its config home (the
 * descriptor's `transcriptsSubdir`) for the judge to read (spec section 6).
 *
 * The session is identified the same two ways as evidence: `--session <id>` is
 * the generic, harness-agnostic form a harness that exposes a session id to the
 * shell can pass, and otherwise the harness is resolved from the environment
 * (`REGIMEN_HARNESS` or a CLI-set marker) and its current session is resolved
 * from the filesystem. The judge LLM is the engineer's configured Claude,
 * resolved from the environment; assess runs regardless of the enabled flag (the
 * explicit invocation is the consent, spec section 9.6).
 */
export async function assess(options: {
  dataDir: string;
  session?: string;
  judgeModel?: string;
  judgeVia?: "cli" | "api";
  /** The setup source; defaults to the live adapter. Tests inject a stub. */
  setupSource?: SetupSource;
}): Promise<number> {
  const { dataDir: dir } = options;
  // The judge LLM is the engineer's configured Claude, resolved from env at
  // runtime (the judgeModel option overrides the model). Resolving it inside
  // the try keeps a missing key (or any resolution failure) on the clean
  // stderr-plus-exit-1 path rather than an unhandled rejection.
  const judgeModel = options.judgeModel;
  const judgeVia = options.judgeVia;

  // Assess writes the store (events + verdict), so it opens read-write, unlike
  // the read-only evidence command. It runs regardless of the enabled flag: the
  // explicit invocation against a named transcript is the consent (spec 9.6).
  // Opened before target resolution: a --session prefix resolves against this
  // same store (see resolveAssessTarget).
  const store = openStore(join(dir, "feedback.db"));
  try {
    // One resolution path for every single-session judging surface: assess, the
    // tier C emit, and the tier C record all resolve the harness, its location,
    // and the session id through {@link resolveAssessTarget}, so the fail-closed
    // messages cannot drift apart.
    const target = resolveAssessTarget(options.session, dir, store.db);
    if (target === null) return 1;
    const { harness, sessionsDir, sessionId } = target;

    const resolved = resolveJudgeModel({
      ...(judgeModel === undefined ? {} : { model: judgeModel }),
      ...(judgeVia === undefined ? {} : { judgeVia }),
    });
    // Bind the live setup adapter so real judging is setup-aware; a test injects
    // a stub instead. The judge resolves the engineer's setup as of the
    // conversation's time through this source.
    const setupSource = options.setupSource ?? createLiveSetupSource();
    const digest = await assessConversation({
      store,
      harness,
      sessionsDir,
      sessionId,
      llm: resolved.port,
      judgeBackend: resolved.backend,
      setupSource,
    });
    process.stdout.write(`${JSON.stringify(digest)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * `regimen assess --all`: judge many conversations in one sweep. Selects the
 * conversations matching `filter` (default skip already-judged; `--force`
 * re-judges), then judges them in batches of `batchSize`, pausing between batches
 * for the injected `decideNextBatch` (the CLI supplies the interactive prompt).
 * Each conversation is judged exactly as the single-session `assess` does, by its
 * own harness, and persisted identically. Continue-on-error: a conversation whose
 * transcript is gone is summarized as a failure and the sweep moves on. Prints
 * the opening accounting, a line per conversation, and an end summary.
 */
export async function assessAll(options: {
  dataDir: string;
  filter: SessionFilter;
  force: boolean;
  batchSize: number;
  judgeModel?: string;
  judgeVia?: "cli" | "api";
  /** The setup source; defaults to the live adapter. Tests inject a stub. */
  setupSource?: SetupSource;
  decideNextBatch: () => Promise<BatchDecision>;
}): Promise<number> {
  const store = openStore(join(options.dataDir, "feedback.db"));
  try {
    // Freeze the clock once so relative since/until filters resolve to the same
    // instant for the opening counts and the sweep selection; separate Date.now()
    // calls could otherwise disagree across a relative boundary.
    const sweepNow = Date.now();
    const now = (): number => sweepNow;
    const sessions = listSessions(store.db, options.filter, now);
    const matched = sessions.length;
    // Count the fixed facts straight from the session state so they never fold
    // into each other: `missing` is durably marked transcript-gone, and
    // `alreadyJudged` is judged with the transcript still present (a missing
    // session was never judged, so the two buckets stay disjoint). Both are
    // independent of `force`; only `toJudge` grows when `force` re-offers the
    // already-judged.
    const missing = sessions.filter(
      (s) => s.transcriptMissingAt !== null,
    ).length;
    const alreadyJudged = sessions.filter(
      (s) => s.judged && s.transcriptMissingAt === null,
    ).length;
    const toJudge = selectSessionsToJudge(
      store.db,
      options.filter,
      { force: options.force },
      now,
    ).length;
    process.stdout.write(
      `sweep: matched ${matched}, already judged ${alreadyJudged}, missing ${missing}, to judge ${toJudge}\n`,
    );

    // Nothing to judge: report the empty run and skip judge-backend resolution,
    // so an all-judged sweep succeeds without a configured judge.
    if (toJudge === 0) {
      process.stdout.write(
        `done: judged 0 (complete 0, signals-only 0, incomplete 0), newly missing 0, failed 0, skipped 0\n`,
      );
      return 0;
    }

    let resolved;
    try {
      resolved = resolveJudgeModel({
        ...(options.judgeModel === undefined
          ? {}
          : { model: options.judgeModel }),
        ...(options.judgeVia === undefined
          ? {}
          : { judgeVia: options.judgeVia }),
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
    // Bind the live setup adapter once for the whole sweep so every conversation
    // is judged setup-aware (the same instance threads each one's own time and
    // cwd through resolve); a test injects a stub instead.
    const setupSource = options.setupSource ?? createLiveSetupSource();
    let index = 0;
    const judge = async (session: SessionSummary): Promise<SweepOutcome> => {
      index++;
      const label = `[${index}/${toJudge}] ${session.harness} ${session.sessionId}`;
      try {
        const { sessionsDir } = resolveHarnessLocation(
          session.harness,
          process.env,
        );
        const digest = await assessConversation({
          store,
          harness: session.harness as Harness,
          sessionsDir,
          sessionId: session.sessionId,
          llm: resolved.port,
          judgeBackend: resolved.backend,
          setupSource,
        });
        // Classify how the run finished so the sweep summary can distinguish a
        // fully-persisted verdict from a thinner one. A complete run with an
        // assessment narrative is the full verdict; a complete run with no
        // narrative persisted only signals; anything not complete is incomplete.
        const sweepOutcome: SweepOutcome =
          digest.judged && digest.complete
            ? digest.assessment !== null
              ? "complete"
              : "signals-only"
            : "incomplete";
        const shown =
          digest.judged && digest.complete
            ? (digest.outcome?.value ?? sweepOutcome)
            : "incomplete";
        process.stdout.write(`${label} -> ${shown}\n`);
        return sweepOutcome;
      } catch (caught) {
        // Print inline so progress numbering stays contiguous, then re-throw so
        // the engine records it. A gone transcript is durably marked and reported
        // apart from a generic failure, so label the two distinctly.
        const inline =
          caught instanceof TranscriptNotFoundError ? "MISSING" : "FAILED";
        process.stdout.write(`${label} -> ${inline}\n`);
        throw caught;
      }
    };
    const summary = await runSweep(store.db, {
      filter: options.filter,
      force: options.force,
      batchSize: options.batchSize,
      judge,
      decideNextBatch: options.decideNextBatch,
      now,
    });
    process.stdout.write(
      `done: judged ${summary.judged.length} (complete ${summary.complete.length}, signals-only ${summary.signalsOnly.length}, incomplete ${summary.incomplete.length}), newly missing ${summary.missingTranscript.length}, failed ${summary.failed.length}, skipped ${summary.skipped.length}\n`,
    );
    for (const missing of summary.missingTranscript) {
      process.stdout.write(
        `  missing: ${missing.harness} ${missing.sessionId} (transcript gone; marked so future sweeps skip it)\n`,
      );
    }
    for (const failure of summary.failed) {
      process.stdout.write(
        `  failed: ${failure.session.harness} ${failure.session.sessionId} (${failure.error.message})\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

/** The resolved judging target: the env-detected harness, its sessions dir, and the session id. */
interface AssessTarget {
  readonly harness: Harness;
  readonly sessionsDir: string;
  readonly sessionId: string;
}

/**
 * Below this length a `--session` value is treated as a prefix to resolve
 * against the store (the 8 characters `regimen list` prints in its session
 * column) rather than a literal full id; a real session id (a UUID) is at
 * least this long. Keeping full ids on the direct passthrough means an
 * already-known full id still resolves even before capture has written its
 * conversations row (the transcript-only case a fresh, not-yet-captured
 * session exercises).
 */
const MIN_FULL_SESSION_ID_LENGTH = 32;

/**
 * Resolve the judging target the same way `assess` does: the harness from the
 * environment (never a flag), its sessions dir from the registry, and the
 * session id from `--session` or the harness's current-session resolver. A
 * `--session` value shorter than a full id is resolved against the store
 * FIRST (the transcript locator that runs after this needs the full id; an
 * unambiguous prefix resolves, an ambiguous or unmatched one fails closed with
 * an actionable stderr reason). Writes the fail-closed diagnostic to stderr
 * and returns null on any resolution failure, so the caller exits 1 with a
 * clean message. Shared by the tier C emit and record facades.
 */
function resolveAssessTarget(
  session: string | undefined,
  dataDir: string,
  db: Database,
): AssessTarget | null {
  let harness;
  try {
    harness = resolveHarnessFromEnvironment(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return null;
  }
  if (harness === undefined) {
    process.stderr.write(`${NO_HARNESS}\n`);
    return null;
  }
  let location;
  try {
    location = resolveHarnessLocation(harness, process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return null;
  }
  const { support, harnessHome, sessionsDir } = location;
  let sessionId: string | null = null;
  if (session !== undefined) {
    if (session.length >= MIN_FULL_SESSION_ID_LENGTH) {
      sessionId = session;
    } else {
      const resolved = resolveSessionId(db, session);
      if (!resolved.ok) {
        process.stderr.write(`${resolved.reason}\n`);
        return null;
      }
      sessionId = resolved.sessionId;
    }
  } else {
    sessionId = support.resolver.resolveCurrent({
      dataDir,
      harnessHome,
      cwd: process.cwd(),
    });
    if (sessionId === null) {
      process.stderr.write(
        `could not resolve the current ${harness} session id\n`,
      );
      return null;
    }
  }
  return { harness, sessionsDir, sessionId };
}

/**
 * `regimen assess --emit-prompt`: the tier C zero-key path, front half. Prints
 * the exact versioned judge prompt envelope (sessionId, versions, system, user)
 * on stdout for one conversation and writes no assessment run, so the calling
 * agent can produce the verdict itself. Opens the store read-write only to
 * insert the load-bearing anchor events (idempotent); makes no LLM call.
 */
export async function emitPrompt(options: {
  dataDir: string;
  session?: string;
  setupSource?: SetupSource;
}): Promise<number> {
  const store = openStore(join(options.dataDir, "feedback.db"));
  try {
    const target = resolveAssessTarget(
      options.session,
      options.dataDir,
      store.db,
    );
    if (target === null) return 1;
    const envelope = agentEmitPrompt({
      store,
      harness: target.harness,
      sessionsDir: target.sessionsDir,
      sessionId: target.sessionId,
      ...(options.setupSource === undefined
        ? {}
        : { setupSource: options.setupSource }),
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * `regimen assess --record-verdict`: the tier C zero-key path, back half. Reads
 * one verdict envelope from stdin (passed as `input`), re-validates it through
 * the same verdict pipeline the in-process judge uses, and persists it stamped
 * judge_backend=agent, printing the resulting digest. Rejects a malformed,
 * stale (version mismatch), mismatched-session, or unanchorable verdict with a
 * stderr reason and exit 1, writing nothing.
 */
export async function recordVerdict(options: {
  dataDir: string;
  session?: string;
  input: string;
}): Promise<number> {
  let envelope: RecordEnvelope;
  try {
    envelope = JSON.parse(options.input) as RecordEnvelope;
  } catch {
    process.stderr.write("the verdict envelope on stdin was not valid JSON\n");
    return 1;
  }
  const store = openStore(join(options.dataDir, "feedback.db"));
  try {
    const target = resolveAssessTarget(
      options.session,
      options.dataDir,
      store.db,
    );
    if (target === null) return 1;
    const outcome = agentRecordVerdict({
      store,
      harness: target.harness,
      sessionsDir: target.sessionsDir,
      sessionId: target.sessionId,
      envelope,
    });
    if (!outcome.ok) {
      process.stderr.write(`${outcome.reason}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(outcome.digest)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * `regimen rollup`: read across the persisted per-conversation verdicts matching
 * `filter` and answer how work is going, what keeps recurring, and what to do,
 * as a colleague-voiced narrative over a deterministic header of numbers (the
 * SQL-vs-model split: the header owns every count, the model only interprets).
 * Opens the store read-only (the rollup writes nothing). An empty slice (no
 * store, or no judged conversations matching the filter) short-circuits to a
 * header-only rollup with no synthesis and resolves NO judge backend, so a rollup
 * over zero judged conversations is free and needs no configured judge (mirroring
 * the sweep's nothing-to-judge path). Otherwise it resolves the synthesis backend
 * exactly as `assess` does (sharing `--judge-model` and `--judge-via`, including
 * the Bedrock no-key CLI path) and prints the VerdictRollup as JSON under
 * `--json` or as the rendered narrative-over-numbers view. `llm` is an injected
 * test seam; production resolves the backend.
 */
export async function rollup(options: {
  dataDir: string;
  filter: SessionFilter;
  asJson: boolean;
  judgeModel?: string;
  judgeVia?: "cli" | "api";
  llm?: JudgeModelPort;
}): Promise<number> {
  const { dataDir: dir, filter, asJson } = options;
  const now = Date.now;
  const storePath = join(dir, "feedback.db");
  if (!existsSync(storePath)) {
    printRollup(emptyRollup(filter, now), asJson);
    return 0;
  }
  // Constructed inside the guarded scope (the pattern `list` follows): a store
  // that exists but cannot be opened (permissions, corruption, a TOCTOU race
  // after the existsSync check) lands on the same stderr-plus-exit-1 path as
  // every other failure here, never an unhandled throw.
  let db: Database | undefined;
  try {
    db = new Database(storePath, { readonly: true });
    // An empty slice short-circuits before backend resolution, so an empty
    // rollup succeeds without a configured judge (the sweep's symmetry).
    if (rollupHeader(db, filter, now).totalJudged === 0) {
      printRollup(emptyRollup(filter, now), asJson);
      return 0;
    }
    let port = options.llm;
    if (port === undefined) {
      port = resolveJudgeModel({
        ...(options.judgeModel === undefined
          ? {}
          : { model: options.judgeModel }),
        ...(options.judgeVia === undefined
          ? {}
          : { judgeVia: options.judgeVia }),
      }).port;
    }
    const result = await rollupVerdicts(db, { filter, llm: port, now });
    printRollup(result, asJson);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

/** The header-only rollup for an empty slice: no synthesis, no model call. */
function emptyRollup(filter: SessionFilter, now: () => number): VerdictRollup {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    header: { totalJudged: 0, distributions: [] },
    synthesis: null,
    filter,
  };
}

/**
 * Print a VerdictRollup: the full JSON under `--json` for a skill to consume, or
 * the rendered human view. The human view leads with the synthesis narrative
 * (colleague voice) and prints the deterministic header numbers beneath it,
 * always from the header fields and never re-derived from the prose, so the true
 * counts stand regardless of what the narrative says. An empty slice says so
 * plainly.
 */
function printRollup(rollup: VerdictRollup, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rollup)}\n`);
    return;
  }
  process.stdout.write(formatRollup(rollup));
}

/** Render a VerdictRollup as the narrative-over-numbers human view. */
function formatRollup(rollup: VerdictRollup): string {
  if (rollup.synthesis === null) {
    return "No assessed conversations in this slice yet; nothing to roll up.\n";
  }
  const numbers = [
    `judged conversations: ${rollup.header.totalJudged}`,
    ...rollup.header.distributions.map((dist) => {
      const buckets = dist.buckets
        .map((bucket) => `${bucket.value} ${bucket.count}`)
        .join(", ");
      return `  ${dist.signalName}: ${buckets}`;
    }),
  ].join("\n");
  return `${rollup.synthesis.prose}\n\nThe numbers behind this:\n${numbers}\n`;
}

/**
 * `regimen audit`: the leverage audit (ADR-0016 capability 2). Reads the store
 * deterministically for each established practice's liveness (how many
 * conversations it was in force for, via the setup snapshots, versus how many it
 * actually fired in, via `skill_invocations`) plus the convention-adherence
 * distribution, then synthesizes a colleague-voiced health summary. The synthesis
 * consults the judge model ONLY when a practice is idle (silently unused): an
 * all-healthy or empty read prints a deterministic line and makes no paid call, so
 * a clean audit costs nothing.
 *
 * The practices in force NOW come from the live setup source (a test injects a
 * stub) so a brand-new practice no conversation has run under yet surfaces as
 * too-new, and every practice is marked whether it is still in the current setup.
 * Time-scoping lives in the deterministic read: a conversation predating a
 * practice never carried it in its snapshot, so it never counts against it. Opens
 * the store readonly; an absent store audits an empty (in-memory) one so a
 * brand-new practice still reports.
 */
export async function audit(options: {
  dataDir: string;
  filter?: AuditFilter;
  judgeModel?: string;
  judgeVia?: "cli" | "api";
  /** The setup source; defaults to the live adapter. Tests inject a stub. */
  setupSource?: SetupSource;
}): Promise<number> {
  const setupSource = options.setupSource ?? createLiveSetupSource();
  const setup = setupSource.resolve({ cwd: process.cwd(), asOf: new Date() });
  const currentLevers = setup?.practices.map((practice) => practice.name) ?? [];

  const storePath = join(options.dataDir, "feedback.db");
  const persisted = existsSync(storePath);
  // An absent store means nothing has been captured yet; audit an empty in-memory
  // store so a currently-in-force practice still reports (as too-new).
  const store = persisted ? undefined : openStore(":memory:");
  const db = store?.db ?? new Database(storePath, { readonly: true });
  try {
    const report = leverageAudit(db, {
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      currentLevers,
    });

    // The judge is resolved only when a practice is idle, so a clean audit needs
    // no configured backend. A resolution failure on the deep-dive path fails
    // loudly (stderr + exit 1), mirroring assess.
    let llm;
    if (report.levers.some((lever) => lever.health === "idle")) {
      try {
        llm = resolveJudgeModel({
          ...(options.judgeModel === undefined
            ? {}
            : { model: options.judgeModel }),
          ...(options.judgeVia === undefined
            ? {}
            : { judgeVia: options.judgeVia }),
        }).port;
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        return 1;
      }
    }

    const synthesis = await synthesizeAudit(
      report,
      llm === undefined ? {} : { llm },
    );
    process.stdout.write(`${synthesis.narrative}\n`);
    return 0;
  } finally {
    if (store !== undefined) store.close();
    else db.close();
  }
}

/**
 * `regimen calibrate`: the READ-ONLY judge calibration harness. It measures a
 * candidate judge configuration (any backend/model, resolved through the same
 * `--judge-model`/`--judge-via` flags as assess) against the reference sessions
 * without ever writing to the store: it reuses the emit-prompt preparation path
 * to build the exact versioned prompt, calls the candidate directly, runs the
 * response through the shared verdict pipeline, and compares in memory.
 *
 * Two modes: CALIBRATION scores per-signal agreement against the stored baseline
 * at the same rubric version; HEALTH is a rubric-regression check of the
 * candidate's own elicitation. `--save-golden` writes the `--sessions` list to
 * the golden file and exits. With neither `--sessions` nor a golden file it fails
 * closed. The store opens read-write only for the idempotent anchor-event insert
 * the read path already does; no assessment run and no setup snapshot are
 * written. Exit code gates: 0 on PASS, 1 on FAIL.
 */
export async function calibrate(options: {
  dataDir: string;
  configDir: string;
  mode: CalibrationMode;
  sessionIds?: ReadonlyArray<string>;
  saveGolden?: boolean;
  judgeModel?: string;
  judgeVia?: "cli" | "api";
  asJson?: boolean;
  /** The candidate judge port; defaults to the resolved backend. Tests inject a stub. */
  candidate?: JudgeModelPort;
  /** The setup source; defaults to the live adapter. Tests inject a stub. */
  setupSource?: SetupSource;
}): Promise<number> {
  const adHoc = options.sessionIds ?? [];

  // `--save-golden` is a pure write of the golden set from the `--sessions`
  // list, then exit: it runs no judge and touches no store.
  if (options.saveGolden) {
    if (adHoc.length === 0) {
      process.stderr.write(
        "nothing to save: pass --sessions <id,...> with --save-golden\n",
      );
      return 1;
    }
    const entries: GoldenEntry[] = adHoc.map((sessionId) => ({ sessionId }));
    writeGolden(options.configDir, entries);
    process.stdout.write(
      `saved ${entries.length} session(s) to ${goldenPath(options.configDir)}\n`,
    );
    return 0;
  }

  let golden: GoldenEntry[] | undefined;
  try {
    golden = readGolden(options.configDir);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  // The reference set: the ad-hoc `--sessions` list (carrying any golden
  // expectations for a matching id) when given, else the golden file.
  let entries: GoldenEntry[];
  if (adHoc.length > 0) {
    const byId = new Map((golden ?? []).map((e) => [e.sessionId, e]));
    entries = adHoc.map((sessionId) => byId.get(sessionId) ?? { sessionId });
  } else if (golden !== undefined && golden.length > 0) {
    entries = golden;
  } else {
    process.stderr.write(
      "no sessions to calibrate: pass --sessions <id,...> or create a golden set with --save-golden\n",
    );
    return 1;
  }

  const store = openStore(join(options.dataDir, "feedback.db"));
  try {
    let candidate = options.candidate;
    if (candidate === undefined) {
      try {
        candidate = resolveJudgeModel({
          ...(options.judgeModel === undefined
            ? {}
            : { model: options.judgeModel }),
          ...(options.judgeVia === undefined
            ? {}
            : { judgeVia: options.judgeVia }),
        }).port;
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        return 1;
      }
    }

    const targets: CalibrateTarget[] = [];
    const unresolved: string[] = [];
    for (const entry of entries) {
      const resolvedId = resolveSessionId(store.db, entry.sessionId);
      if (!resolvedId.ok) {
        unresolved.push(`${entry.sessionId}: ${resolvedId.reason}`);
        continue;
      }
      const slice = sessionHarnessModel(store.db, resolvedId.sessionId);
      if (slice === null) {
        unresolved.push(
          `${entry.sessionId}: no captured conversation row (unknown harness)`,
        );
        continue;
      }
      let location;
      try {
        location = resolveHarnessLocation(slice.harness, process.env);
      } catch (err) {
        unresolved.push(`${entry.sessionId}: ${(err as Error).message}`);
        continue;
      }
      targets.push({
        harness: slice.harness as Harness,
        sessionsDir: location.sessionsDir,
        sessionId: resolvedId.sessionId,
        ...(entry.expect === undefined ? {} : { expect: entry.expect }),
      });
    }

    const setupSource = options.setupSource ?? createLiveSetupSource();
    const report = await calibrateSessions({
      store,
      mode: options.mode,
      targets,
      candidate,
      setupSource,
    });

    if (options.asJson) {
      process.stdout.write(`${JSON.stringify({ ...report, unresolved })}\n`);
    } else {
      process.stdout.write(formatCalibration(report));
      for (const problem of unresolved) {
        process.stdout.write(`unresolved ${problem}\n`);
      }
    }
    // Any session that could not even be resolved fails the gate: the harness
    // cannot certify a reference set it could not run over.
    return report.pass && unresolved.length === 0 ? 0 : 1;
  } finally {
    store.close();
  }
}

/**
 * `feedback list`: enumerate stored sessions, optionally filtered by harness,
 * model, time window (`--since`/`--until`, an ISO date or an `Nd`/`Nh` offset),
 * and outcome. The selection primitive `listSessions` returns DATA ONLY: this
 * command reads the store readonly, opens nothing when the store file is absent
 * (printing an empty result and exiting 0), and renders either a compact table
 * with a one-line count footer or, under `--json`, the full SessionSummary array
 * the in-session agent consumes. No LLM, no judgment, no synthesis.
 *
 * A session whose model is still null (Copilot and Gemini hook payloads carry
 * no model field, unlike Claude and Codex) is backfilled from its transcript at
 * render time, per session, before printing: {@link backfillTranscriptModel}.
 * This is a display-time read, not a store write, so `list` stays readonly.
 */
export function list(options: {
  dataDir: string;
  filter: SessionFilter;
  asJson: boolean;
}): number {
  const { dataDir: dir, filter, asJson } = options;
  let sessions: ReadonlyArray<SessionSummary>;
  const storePath = join(dir, "feedback.db");
  if (!existsSync(storePath)) {
    sessions = [];
  } else {
    let db: Database | undefined;
    try {
      db = new Database(storePath, { readonly: true });
      sessions = listSessions(db, filter);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    } finally {
      db?.close();
    }
  }

  sessions = sessions.map((session) => {
    if (session.model !== null) return session;
    const model = backfillTranscriptModel(session, process.env);
    return model === undefined ? session : { ...session, model };
  });

  process.stdout.write(
    asJson ? `${JSON.stringify(sessions)}\n` : formatSessionTable(sessions),
  );
  return 0;
}

/**
 * The model carried by `session`'s own transcript, read live through the same
 * resolver+reader pair `assessConversation` uses, or undefined when no model is
 * discoverable (an unsupported/unresolvable harness, no transcript on disk, or a
 * transcript that itself carries no model). Never throws: a harness a `list`
 * caller has no config-home env var for, or a session with no transcript yet, is
 * routine, not an error, so this stays best-effort rather than fail-closed like
 * `assessConversation`'s own transcript lookup.
 */
function backfillTranscriptModel(
  session: SessionSummary,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let location: HarnessLocation;
  try {
    location = resolveHarnessLocation(session.harness, env);
  } catch {
    return undefined;
  }
  const located = location.support.resolver.locate({
    sessionsDir: location.sessionsDir,
    sessionId: session.sessionId,
  });
  if (located === null) return undefined;

  let content: string;
  try {
    content = readFileSync(located.path, "utf8");
  } catch {
    return undefined;
  }

  const read = location.support.reader.read(content, {
    complete: !located.open,
  });
  for (const event of read.events) {
    if (event.model !== undefined && event.model.length > 0) {
      return event.model;
    }
  }
  return undefined;
}

/** The list-table columns, in render order, each a (header, cell) projection. */
const SESSION_COLUMNS: ReadonlyArray<{
  header: string;
  cell: (s: SessionSummary) => string;
}> = [
  { header: "date", cell: (s) => s.lastEventAt.slice(0, 10) },
  { header: "harness", cell: (s) => s.harness },
  { header: "model", cell: (s) => s.model ?? "-" },
  { header: "events", cell: (s) => String(s.eventCount) },
  { header: "judged", cell: (s) => (s.judged ? "y" : "n") },
  { header: "outcome", cell: (s) => s.outcome ?? "-" },
  { header: "session", cell: (s) => s.sessionId.slice(0, 8) },
];

/**
 * Render sessions as a compact, column-aligned human-readable table, one row
 * per session, under a header row and above a one-line count footer. The model
 * and outcome fall back to `-` when null. An empty result prints just the
 * header and the `0 sessions` footer so the command always says something
 * concrete. Column widths size to the widest cell so the columns line up.
 */
function formatSessionTable(sessions: ReadonlyArray<SessionSummary>): string {
  const widths = SESSION_COLUMNS.map((col) =>
    sessions.reduce(
      (max, s) => Math.max(max, col.cell(s).length),
      col.header.length,
    ),
  );
  const renderRow = (cells: ReadonlyArray<string>): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  const header = renderRow(SESSION_COLUMNS.map((col) => col.header));
  const rows = sessions.map((s) =>
    renderRow(SESSION_COLUMNS.map((col) => col.cell(s))),
  );
  const footer = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  return `${[header, ...rows, footer].join("\n")}\n`;
}

/**
 * Copy every bundled skill into the harness's skills subdirectory, where the
 * harness discovers them. The bundle ships `regimen-evidence` (deterministic),
 * `regimen-judgment` (its judged twin), and `regimen-ask` (the generalized ask
 * surface); the planner returns one plan per skill, so another bundled skill
 * installs without touching this loop. The
 * harness is resolved from the environment and its home from the contract;
 * `--dry-run` reports the targets without writing. The bundle lives two levels
 * up from this file (the repo root's `skills/` directory).
 */
export function installSkill(options: { dryRun: boolean }): number {
  const target = resolveHarnessTarget();
  if (target === null) return 1;
  const bundleDir = resolve(import.meta.dir, "..", "..");
  const plans = planSkillInstall({
    home: target.home,
    bundleDir,
    contract: target.descriptor.contract,
  });

  if (options.dryRun) {
    for (const plan of plans) {
      process.stdout.write(`would write ${plan.targetPath}\n`);
    }
    return 0;
  }
  for (const plan of plans) {
    mkdirSync(dirname(plan.targetPath), { recursive: true });
    copyFileSync(plan.sourcePath, plan.targetPath);
    process.stdout.write(`installed ${plan.targetPath}\n`);
  }
  return 0;
}

/**
 * The harnesses Feedback can install, in registration order: the ones with a
 * capture descriptor. The unified CLI loops this set for `regimen install --all`
 * so the cross-harness install never restates the harness list itself.
 */
export function installableHarnesses(): string[] {
  return [...HARNESS_DESCRIPTORS.keys()];
}

/**
 * Where a harness's capture install lands, the load-bearing manifest `scope`
 * (ADR-0012, ADR-0011). A harness whose descriptor carries a capture
 * `groupDecoration` (Gemini) only fires PROJECT-level hooks headless, so it
 * installs per-workspace and the scope records that workspace as
 * `workspace:<cwd>`; every other harness installs into its config home, scope
 * `config-home`. Takes the workspace path so the caller pins it (the dispatcher
 * passes the cwd, mirroring `captureHooksPath`). A harness with no descriptor
 * (an unknown identifier) has no per-workspace requirement, so it falls to the
 * config-home default.
 */
export function installScope(harness: string, workspace: string): string {
  const descriptor = HARNESS_DESCRIPTORS.get(harness as Harness);
  if (descriptor?.capture.groupDecoration !== undefined) {
    return `workspace:${workspace}`;
  }
  return "config-home";
}

/**
 * The harness an install/uninstall command targets and where its config home is.
 * The harness is resolved from the environment (`REGIMEN_HARNESS` or a CLI-set
 * marker), validated to a registered descriptor and failing closed (clear
 * stderr, null return) when none resolves or the resolved one has no descriptor.
 * The config home is the contract's env-var override when set (e.g. CODEX_HOME),
 * else derived from the descriptor's contract via `resolveHarnessHome`.
 */
interface HarnessTarget {
  readonly descriptor: HarnessDescriptor;
  readonly home: string;
}

function resolveHarnessTarget(): HarnessTarget | null {
  let harness;
  try {
    harness = resolveHarnessFromEnvironment(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return null;
  }
  if (harness === undefined) {
    process.stderr.write(`${NO_HARNESS}\n`);
    return null;
  }
  const support = harnessSupport(harness);
  if (support === undefined) {
    process.stderr.write(`unsupported harness: ${harness}\n`);
    return null;
  }
  const { descriptor } = support;

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (
    home === undefined &&
    process.env[descriptor.contract.configHome.envVar] === undefined
  ) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return null;
  }
  return {
    descriptor,
    home: resolveHarnessHome(descriptor.contract, process.env, home ?? ""),
  };
}

/**
 * Read and parse a harness hooks file, or undefined when no file exists. The
 * concrete on-disk shape (`nested-matcher-groups` vs `versioned-command-leaves`)
 * is selected by the planner from the descriptor's format, so the parse boundary
 * widens to the union and the planner narrows it.
 */
function readHooksFile(
  path: string,
): HooksFile | VersionedHooksFile | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as
    | HooksFile
    | VersionedHooksFile;
}

/**
 * The on-disk path the capture hooks file lives at for a resolved target. Most
 * harnesses keep their hooks under the config home (`<home>/<relativePath>`). A
 * harness whose descriptor carries a capture `groupDecoration` (Gemini, per
 * ADR-0011) only fires PROJECT-level hooks headless, so its file is the
 * per-workspace `<cwd>/<configSubdir>/<relativePath>` (e.g.
 * `<cwd>/.gemini/settings.json`), where the workspace is the current directory.
 */
function captureHooksPath(target: HarnessTarget): string {
  const { contract } = target.descriptor;
  if (target.descriptor.capture.groupDecoration !== undefined) {
    // ponytail: workspace = process.cwd(), no `--workspace` flag. Mirrors the
    // e2e gate, which installs into the dir the agent runs in; add a flag only
    // when a real caller needs to target a workspace other than the cwd.
    return join(
      process.cwd(),
      contract.configHome.defaultSubdir,
      contract.hooksFile.relativePath,
    );
  }
  return join(target.home, contract.hooksFile.relativePath);
}

/** A one-line description of a wiring change for the CLI to print. */
function describeChange(c: WireChange): string {
  return `capture on ${c.event}`;
}

/**
 * `feedback wire-hooks`. Merge Feedback's capture hook (the harness's capture
 * events) into the harness hooks file idempotently, without clobbering the
 * user's own hooks or any foreign enforcement gate leaves (owned by
 * the enforcement package). The descriptor supplies the events, producer, and hooks
 * file path; the pure planner owns the merge; this command owns the file
 * read/write and the dry-run preview.
 */
export function wireHooks(options: { dryRun: boolean }): number {
  const target = resolveHarnessTarget();
  if (target === null) return 1;
  const clonePath = resolve(import.meta.dir, "..", "..");
  const path = captureHooksPath(target);

  let plan;
  try {
    plan = planCaptureHooks(readHooksFile(path), {
      descriptor: target.descriptor,
      clonePath,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (options.dryRun) {
    if (plan.added.length === 0) {
      process.stdout.write(`hooks already wired in ${path}\n`);
    }
    for (const c of plan.added) {
      process.stdout.write(`would wire ${describeChange(c)}\n`);
    }
    return 0;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan.hooks, null, 2)}\n`);
  if (plan.added.length === 0) {
    process.stdout.write(`hooks already wired in ${path}\n`);
  }
  for (const c of plan.added) {
    process.stdout.write(`wired ${describeChange(c)}\n`);
  }
  // A harness whose freshly-installed hooks need a one-time trust before they
  // fire (Codex) carries a firstUseNotice; print it so first-run capture is not
  // silently empty. Absent on harnesses that fire fresh hooks immediately.
  const notice = target.descriptor.capture.firstUseNotice;
  if (notice !== undefined) {
    process.stdout.write(`${notice}\n`);
  }
  return 0;
}

/**
 * `feedback unwire-hooks`. Remove exactly Feedback's capture entries from the
 * harness hooks file, leaving the user's own hooks and any foreign enforcement
 * gate leaves (owned by the enforcement package) intact. Writes the pruned object
 * back; the file is left in place even when empty (the user may re-add their own
 * hooks to it).
 */
export function unwireHooks(options: { dryRun: boolean }): number {
  const target = resolveHarnessTarget();
  if (target === null) return 1;
  const path = captureHooksPath(target);
  if (!existsSync(path)) {
    process.stdout.write(`no hooks file at ${path}; nothing to remove\n`);
    return 0;
  }

  let plan;
  try {
    plan = planCaptureHooksRemoval(
      readHooksFile(path),
      target.descriptor.contract.hooksFile.format,
    );
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (options.dryRun) {
    if (plan.removed.length === 0) {
      process.stdout.write(`no Regimen entries in ${path}\n`);
    }
    for (const c of plan.removed) {
      process.stdout.write(`would remove ${describeChange(c)}\n`);
    }
    return 0;
  }

  writeFileSync(path, `${JSON.stringify(plan.hooks, null, 2)}\n`);
  if (plan.removed.length === 0) {
    process.stdout.write(`no Regimen entries in ${path}\n`);
  }
  for (const c of plan.removed) {
    process.stdout.write(`removed ${describeChange(c)}\n`);
  }
  return 0;
}

/**
 * `feedback install`: stand up the Feedback instrument in one command. A thin
 * orchestrator over the existing writers; the depth lives in each step. Order:
 * enable capture (the privacy gate), install + load the daemon (Feedback live
 * capture), wire the harness capture hook, install both bundled skills
 * (Guidance), and link the CLI onto PATH so the skills can invoke `feedback`.
 * Every step honors `--dry-run`; a failing step stops the run and exits nonzero
 * so a partial install never reports success. The harness is resolved from the
 * environment and flows through to the hooks and skill steps. The Enforcement
 * pillar (the discipline gates) is installed separately from the enforcement
 * package.
 *
 * `daemon: false` (the unified CLI's `--no-daemon`) skips the daemon step
 * entirely: no service file is written and no supervisor command runs, for an
 * account that cannot register a scheduled task. The capture wiring (enable,
 * hooks, skills, self-link) still runs, and one line states the loader is not
 * running and how to drain the buffer by hand. Defaults to installing the daemon.
 */
export function install(options: {
  dataDir: string;
  dryRun: boolean;
  selfLink?: boolean;
  daemon?: boolean;
}): number {
  const { dataDir: dir, dryRun } = options;
  process.stdout.write("Feedback install (capture + daemon + skills)\n");

  if (dryRun) {
    process.stdout.write("would enable feedback (capture + storage)\n");
  } else if (isEnabled(dir)) {
    process.stdout.write("feedback already enabled\n");
  } else {
    setEnabled(dir);
    process.stdout.write("feedback enabled\n");
  }

  if (options.daemon === false) {
    process.stdout.write(`${DAEMON_SKIPPED_NOTICE}\n`);
  } else {
    const daemon = installDaemon({ dataDir: dir, dryRun });
    if (daemon !== 0) return daemon;
  }

  const hooks = wireHooks({ dryRun });
  if (hooks !== 0) return hooks;

  const skill = installSkill({ dryRun });
  if (skill !== 0) return skill;

  // The self-link is skipped when the unified `regimen` dispatcher composes this
  // install: it owns the one `regimen` link (ADR-0012) so two pillars do not each
  // link a separate bin. A standalone caller defaults to linking as before.
  if (options.selfLink !== false) {
    const link = runLifecycleCommands([["bun", "link"]], dryRun);
    if (link !== 0) {
      process.stderr.write("failed to link the feedback CLI onto PATH\n");
      return link;
    }
  }

  process.stdout.write(
    dryRun
      ? "dry run complete; nothing was changed\n"
      : options.daemon === false
        ? "Regimen installed without the daemon; drain the buffer yourself as noted above\n"
        : "Regimen installed; run `regimen status` to confirm the daemon is live\n",
  );
  return 0;
}

/**
 * `feedback uninstall`: tear down what `install` set up, in reverse. Disable
 * capture, unwire the harness hooks (leaving the user's own hooks intact),
 * remove the bundled skills, uninstall the daemon, and unlink the CLI. Best
 * effort: a failing step is recorded but the rest still run, so a half-installed
 * system can always be cleaned up. Honors `--dry-run`; the harness is resolved
 * from the environment.
 */
export function uninstall(options: {
  dataDir: string;
  dryRun: boolean;
  selfLink?: boolean;
}): number {
  const { dataDir: dir, dryRun } = options;
  process.stdout.write("Regimen uninstall\n");
  let failed = 0;

  if (dryRun) {
    process.stdout.write("would disable feedback\n");
  } else if (isEnabled(dir)) {
    clearEnabled(dir);
    process.stdout.write("feedback disabled\n");
  } else {
    process.stdout.write("feedback already disabled\n");
  }

  // Best effort: every step runs even if an earlier one failed, so a partial
  // install can always be cleaned up. `||=` would short-circuit once `failed`
  // is non-zero and skip the remaining teardown, so set the flag explicitly.
  if (unwireHooks({ dryRun }) !== 0) failed = 1;
  if (uninstallSkill({ dryRun }) !== 0) failed = 1;
  if (uninstallDaemon({ dataDir: dir, dryRun }) !== 0) failed = 1;

  // Skipped when the unified `regimen` dispatcher composes this teardown: it owns
  // the one `regimen` unlink (ADR-0012). A standalone caller defaults to
  // unlinking as before.
  if (options.selfLink !== false) {
    const unlink = runLifecycleCommands([["bun", "unlink"]], dryRun);
    if (unlink !== 0) {
      process.stderr.write("failed to unlink the feedback CLI\n");
      failed = 1;
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
 * Remove every bundled skill's directory from the harness's skills subdirectory
 * (the inverse of install-skill). Reuses the skill planner to locate each
 * target. A missing directory is not an error: uninstall must be idempotent.
 */
export function uninstallSkill(options: { dryRun: boolean }): number {
  const target = resolveHarnessTarget();
  if (target === null) return 1;
  const bundleDir = resolve(import.meta.dir, "..", "..");
  for (const plan of planSkillInstall({
    home: target.home,
    bundleDir,
    contract: target.descriptor.contract,
  })) {
    const skillDir = dirname(plan.targetPath);
    if (options.dryRun) {
      process.stdout.write(`would remove ${skillDir}\n`);
    } else {
      rmSync(skillDir, { recursive: true, force: true });
      process.stdout.write(`removed ${skillDir}\n`);
    }
  }
  return 0;
}

export function installDaemon(options: {
  dataDir: string;
  dryRun: boolean;
}): number {
  const { dataDir: dir, dryRun } = options;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return 1;
  }
  const ctx = {
    bunPath: process.execPath,
    loaderPath: resolve(import.meta.dir, "..", "loader", "run.ts"),
    dataDir: dir,
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
  };
  const plan = planInstall(ctx, process.platform, home);

  if (dryRun) {
    process.stdout.write(`would write ${plan.servicePath}\n`);
    for (const cmd of plan.installCommands) {
      process.stdout.write(`would run: ${cmd.join(" ")}\n`);
    }
    return 0;
  }

  mkdirSync(dirname(plan.servicePath), { recursive: true });
  writeFileSync(
    plan.servicePath,
    serviceFileBytes(plan.serviceContent, plan.serviceFileEncoding),
  );
  process.stdout.write(`wrote ${plan.servicePath}\n`);
  return runDaemonInstallCommands(plan);
}

export function uninstallDaemon(options: {
  dataDir: string;
  dryRun: boolean;
}): number {
  const { dataDir: dir, dryRun } = options;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return 1;
  }
  const ctx = {
    bunPath: process.execPath,
    loaderPath: resolve(import.meta.dir, "..", "loader", "run.ts"),
    dataDir: dir,
  };
  const plan = planInstall(ctx, process.platform, home);

  if (dryRun) {
    for (const cmd of plan.uninstallCommands) {
      process.stdout.write(`would run: ${cmd.join(" ")}\n`);
    }
    process.stdout.write(`would remove ${plan.servicePath}\n`);
    return 0;
  }
  const code = runCommands(plan.uninstallCommands);
  if (code !== 0) return code;
  try {
    rmSync(plan.servicePath);
    process.stdout.write(`removed ${plan.servicePath}\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return 0;
}

/**
 * The supervisor-command execution seam: runs one command and returns its exit
 * code. `quiet` suppresses the child's stdout and stderr, used for probes whose
 * output is a noisy diagnostic blob (e.g. `launchctl print`) and whose only
 * signal is the exit code. Injected by callers in tests so supervisor commands
 * are never really executed off the host's launchd/systemd/Task Scheduler.
 */
export type CommandRunner = (
  cmd: ReadonlyArray<string>,
  options?: { quiet?: boolean },
) => number;

const spawnCommand: CommandRunner = (cmd, options) => {
  const [head, ...rest] = cmd;
  if (head === undefined) return 0;
  const proc = Bun.spawnSync({
    cmd: [head, ...rest],
    stdout: options?.quiet ? "ignore" : "inherit",
    stderr: options?.quiet ? "ignore" : "inherit",
  });
  return proc.exitCode ?? 1;
};

function runCommands(
  commands: ReadonlyArray<ReadonlyArray<string>>,
  run: CommandRunner = spawnCommand,
): number {
  for (const cmd of commands) {
    if (cmd[0] === undefined) continue;
    process.stdout.write(`running: ${cmd.join(" ")}\n`);
    const code = run(cmd);
    if (code !== 0) {
      process.stderr.write(`command failed (exit ${code}): ${cmd.join(" ")}\n`);
      return code;
    }
  }
  return 0;
}

/**
 * Execute a daemon-install plan's load step idempotently. When the plan carries
 * a `loadGuardCommand` (macOS) and that probe reports the service is already
 * registered, the install is left in place with a calm line rather than running
 * a second `load`, which launchd rejects with "Load failed: 5: Input/output
 * error" every time an update re-runs over a live service. When the guard says
 * not-loaded, or no guard is present, the install commands run as usual and a
 * genuine load failure still surfaces loudly through `runCommands`.
 */
export function runDaemonInstallCommands(
  plan: Pick<InstallPlan, "installCommands" | "loadGuardCommand">,
  run: CommandRunner = spawnCommand,
): number {
  if (
    plan.loadGuardCommand !== undefined &&
    run(plan.loadGuardCommand, { quiet: true }) === 0
  ) {
    process.stdout.write(
      "daemon already registered; leaving the running service in place\n",
    );
    return 0;
  }
  return runCommands(plan.installCommands, run);
}

interface Status {
  enabled: boolean;
  daemon: "not_running" | { pid: number; alive: boolean };
  lastEvent: string | null;
  backlogBytes: number;
  unassessed: number;
}

function readStatus(dir: string): Status {
  const pidPath = join(dir, "daemon.pid");
  let daemon: Status["daemon"] = "not_running";
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      daemon = { pid, alive };
    }
  }

  let lastEvent: string | null = null;
  let unassessed = 0;
  const storePath = join(dir, "feedback.db");
  if (existsSync(storePath)) {
    const db = new Database(storePath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT MAX(timestamp) AS t FROM events")
        .get() as { t: string | null } | null;
      lastEvent = row?.t ?? null;
      unassessed = countUnassessed(db);
    } finally {
      db.close();
    }
  }

  let backlogBytes = 0;
  const buf = bufferDir(dir);
  if (existsSync(buf)) {
    for (const name of readdirSync(buf)) {
      backlogBytes += statSync(join(buf, name)).size;
    }
  }

  return {
    enabled: isEnabled(dir),
    daemon,
    lastEvent,
    backlogBytes,
    unassessed,
  };
}

function formatStatus(s: Status): string {
  const enabledLine = s.enabled ? "enabled" : "disabled";
  const daemonLine =
    s.daemon === "not_running"
      ? "not running"
      : s.daemon.alive
        ? `running (pid ${s.daemon.pid})`
        : `stale pid file (${s.daemon.pid})`;
  const lastEventLine =
    s.lastEvent === null
      ? "never"
      : `${s.lastEvent} (${humanAge(s.lastEvent)} ago)`;
  const backlogLine = `${s.backlogBytes} bytes`;
  return [
    `feedback: ${enabledLine}`,
    `daemon: ${daemonLine}`,
    `last event: ${lastEventLine}`,
    `backlog: ${backlogLine}`,
    `awaiting assessment: ${s.unassessed} conversations`,
    "",
  ].join("\n");
}

function humanAge(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "unknown";
  const ageMs = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
