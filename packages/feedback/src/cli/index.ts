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
  listSessions,
  type SessionFilter,
  type SessionSummary,
} from "../sessions.ts";
import { openStore } from "../store.ts";
import { assessConversation } from "../judged/assess.ts";
import { resolveDefaultJudgeModel } from "../judged/anthropic-adapter.ts";
import {
  runSweep,
  selectSessionsToJudge,
  type BatchDecision,
} from "../judged/sweep.ts";
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
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined && env[envVar] === undefined) {
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
}): Promise<number> {
  const { dataDir: dir } = options;
  // Resolve the harness first, then drive everything (config home, sessions dir,
  // resolver, reader) from its registry entry. The harness comes from the
  // environment (REGIMEN_HARNESS or a CLI-set marker), not a flag; with neither
  // present the command fails closed rather than guessing one.
  let harness;
  try {
    harness = resolveHarnessFromEnvironment(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  if (harness === undefined) {
    process.stderr.write(`${NO_HARNESS}\n`);
    return 1;
  }
  // Config home is the contract's env-var override when set, else a default under
  // the user's home; a set override stands in for an unset HOME so assess can run
  // wherever the harness home is pinned by its own env var.
  let location;
  try {
    location = resolveHarnessLocation(harness, process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  const { support, harnessHome, sessionsDir } = location;

  let sessionId: string | null = options.session ?? null;
  if (sessionId === null) {
    sessionId = support.resolver.resolveCurrent({
      dataDir: dir,
      harnessHome,
      cwd: process.cwd(),
    });
    if (sessionId === null) {
      process.stderr.write(
        `could not resolve the current ${harness} session id\n`,
      );
      return 1;
    }
  }

  // The judge LLM is the engineer's configured Claude, resolved from env at
  // runtime (the judgeModel option overrides the model). Resolving it inside
  // the try keeps a missing key (or any resolution failure) on the clean
  // stderr-plus-exit-1 path rather than an unhandled rejection.
  const judgeModel = options.judgeModel;
  const judgeVia = options.judgeVia;

  // Assess writes the store (events + verdict), so it opens read-write, unlike
  // the read-only evidence command. It runs regardless of the enabled flag: the
  // explicit invocation against a named transcript is the consent (spec 9.6).
  const store = openStore(join(dir, "feedback.db"));
  try {
    const llm = resolveDefaultJudgeModel({
      ...(judgeModel === undefined ? {} : { model: judgeModel }),
      ...(judgeVia === undefined ? {} : { judgeVia }),
    });
    const digest = await assessConversation({
      store,
      harness,
      sessionsDir,
      sessionId,
      llm,
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
  decideNextBatch: () => Promise<BatchDecision>;
}): Promise<number> {
  const store = openStore(join(options.dataDir, "feedback.db"));
  try {
    const matched = listSessions(store.db, options.filter).length;
    // already-judged is the complement of the unjudged (force:false) selection,
    // so the count stays accurate even when --force grows toJudge to everything.
    const unjudged = selectSessionsToJudge(store.db, options.filter, {
      force: false,
    }).length;
    const toJudge = selectSessionsToJudge(store.db, options.filter, {
      force: options.force,
    }).length;
    process.stdout.write(
      `sweep: matched ${matched}, already judged ${matched - unjudged}, to judge ${toJudge}\n`,
    );

    // Nothing to judge: report the empty run and skip judge-backend resolution,
    // so an all-judged sweep succeeds without a configured judge.
    if (toJudge === 0) {
      process.stdout.write(`done: judged 0, failed 0, skipped 0\n`);
      return 0;
    }

    let llm;
    try {
      llm = resolveDefaultJudgeModel({
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
    let index = 0;
    const judge = async (session: SessionSummary): Promise<void> => {
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
          llm,
        });
        const outcome = digest.judged
          ? (digest.outcome?.value ?? "incomplete")
          : "unjudged";
        process.stdout.write(`${label} -> ${outcome}\n`);
      } catch (caught) {
        // Mark the failure inline so progress numbering stays contiguous, then
        // re-throw so the engine records it for the end-summary detail.
        process.stdout.write(`${label} -> FAILED\n`);
        throw caught;
      }
    };
    const summary = await runSweep(store.db, {
      filter: options.filter,
      force: options.force,
      batchSize: options.batchSize,
      judge,
      decideNextBatch: options.decideNextBatch,
    });
    process.stdout.write(
      `done: judged ${summary.judged.length}, failed ${summary.failed.length}, skipped ${summary.skipped.length}\n`,
    );
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

/**
 * `feedback list`: enumerate stored sessions, optionally filtered by harness,
 * model, time window (`--since`/`--until`, an ISO date or an `Nd`/`Nh` offset),
 * and outcome. The selection primitive `listSessions` returns DATA ONLY: this
 * command reads the store readonly, opens nothing when the store file is absent
 * (printing an empty result and exiting 0), and renders either a compact table
 * with a one-line count footer or, under `--json`, the full SessionSummary array
 * the in-session agent consumes. No LLM, no judgment, no synthesis.
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

  process.stdout.write(
    asJson ? `${JSON.stringify(sessions)}\n` : formatSessionTable(sessions),
  );
  return 0;
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
 * harness discovers them. The bundle ships `regimen-evidence` (deterministic)
 * and `regimen-judgment` (its judged twin); the planner returns one plan per
 * skill, so a third bundled skill installs without touching this loop. The
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
        : "Regimen installed; run `feedback status` to confirm the daemon is live\n",
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
  return runCommands(plan.installCommands);
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

function runCommands(commands: ReadonlyArray<ReadonlyArray<string>>): number {
  for (const cmd of commands) {
    const [head, ...rest] = cmd;
    if (head === undefined) continue;
    process.stdout.write(`running: ${cmd.join(" ")}\n`);
    const proc = Bun.spawnSync({
      cmd: [head, ...rest],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) {
      process.stderr.write(
        `command failed (exit ${proc.exitCode}): ${cmd.join(" ")}\n`,
      );
      return proc.exitCode ?? 1;
    }
  }
  return 0;
}

interface Status {
  enabled: boolean;
  daemon: "not_running" | { pid: number; alive: boolean };
  lastEvent: string | null;
  backlogBytes: number;
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
  const storePath = join(dir, "feedback.db");
  if (existsSync(storePath)) {
    const db = new Database(storePath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT MAX(timestamp) AS t FROM events")
        .get() as { t: string | null } | null;
      lastEvent = row?.t ?? null;
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

  return { enabled: isEnabled(dir), daemon, lastEvent, backlogBytes };
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
