/**
 * A bulk-judging sweep (`regimen assess --all`): select many conversations,
 * then judge them in batches.
 *
 * `selectSessionsToJudge` narrows {@link listSessions} to the conversations a
 * sweep should actually judge: by default the ones not yet judged, or every
 * matching conversation when `force` is set (a re-judge after the judging
 * mechanism itself changed). A session durably marked transcript-missing is
 * excluded under both `force` values, since a gone transcript is gone
 * permanently and re-attempting it only wastes the sweep. It is `listSessions`
 * plus a predicate, no new query and no judged-layer dependency: pure selection
 * over the same read.
 *
 * `runSweep` drives that selection through an injected per-conversation judge
 * in batches, pausing between batches for an injected decision (continue / run
 * all remaining / quit). Judge, decision, and clock are all injected, so the
 * engine is exercised with zero real LLM calls and zero terminal. It is
 * sequential and continue-on-error: a conversation whose judge throws is
 * recorded and the sweep moves on, and because already-judged conversations are
 * excluded by selection, a quit-then-rerun resumes for free. A judge that throws
 * the typed transcript-missing error is a special case: the sweep durably marks
 * that session so selection permanently skips it, since a gone transcript never
 * comes back.
 */
import type { Database } from "bun:sqlite";
import {
  listSessions,
  type SessionFilter,
  type SessionSummary,
} from "../sessions.ts";
import {
  hasGrownPastWatermark,
  readCoverageWatermarks,
} from "./auto-assess.ts";
import { TranscriptNotFoundError } from "./read-conversation.ts";
import type { IncompleteReason } from "./types.ts";

/**
 * Durably record that a session's transcript is gone from disk, at `at` (an
 * ISO-8601 instant). Non-destructive: it touches only the marker column, leaving
 * the conversation's captured events, evidence, and any assessment intact. A
 * marked session is excluded from future judge selection.
 */
export function markTranscriptMissing(
  db: Database,
  sessionId: string,
  at: string,
): void {
  db.prepare(
    "UPDATE conversations SET transcript_missing_at = ? WHERE session_id = ?",
  ).run(at, sessionId);
}

/** Options governing which matching conversations a sweep selects. */
export interface SelectOptions {
  /** Re-judge already-judged conversations too, instead of skipping them. */
  readonly force: boolean;
  /**
   * Also re-select an already-judged conversation that has grown past what its
   * verdict covered (ADR-0018). Off by default, so an ordinary sweep keeps
   * skipping everything judged.
   */
  readonly growth?: boolean;
}

/**
 * Select the conversations a sweep should judge. With `force: false` (default
 * sweep behavior) this is the unjudged subset of the filtered conversations;
 * with `force: true` it is every matching conversation. With `growth: true` it
 * is the unjudged subset plus every judged conversation that has grown past its
 * verdict's watermark (ADR-0018). A transcript-missing session is excluded in
 * every case.
 */
export function selectSessionsToJudge(
  db: Database,
  filter: SessionFilter,
  options: SelectOptions,
  now: () => number = Date.now,
): SessionSummary[] {
  const present = listSessions(db, filter, now).filter(
    (session) => session.transcriptMissingAt === null,
  );
  if (options.force) return [...present];
  if (options.growth !== true) return present.filter((s) => !s.judged);
  const watermarks = readCoverageWatermarks(db);
  return present.filter(
    (session) =>
      !session.judged ||
      hasGrownPastWatermark(
        watermarks.get(session.sessionId) ?? null,
        session.eventCount,
      ),
  );
}

/**
 * The choice made between batches of a sweep: judge the next batch, judge all
 * remaining batches without pausing again, or stop now and leave the rest.
 */
export type BatchDecision = "continue" | "all" | "quit";

/**
 * How a resolved judge finished, so the summary can tell a fully-persisted
 * verdict apart from a thinner one rather than reporting one flat `judged` count.
 * `complete` is a clean run with both signals and the assessment narrative;
 * `signals-only` persisted signals but no narrative prose; `incomplete` is a run
 * that did not finish clean (insufficient evidence, unparseable, or unavailable).
 * A judge that resolves without a tag is treated as `complete` (the default full
 * verdict), so a caller that does not classify still totals honestly.
 */
export type SweepOutcome = "complete" | "signals-only" | "incomplete";

/**
 * A judge's resolved outcome carrying the machine reason for an incomplete
 * run, so the sweep summary can report why rather than only that. A judge
 * that has no reason to report (or whose outcome is not `incomplete`) may
 * still resolve with the bare {@link SweepOutcome} string.
 */
export interface SweepJudgeResolution {
  readonly outcome: SweepOutcome;
  readonly incompleteReason?: IncompleteReason;
}

/** One incomplete-outcome session paired with the reason its judge reported. */
export interface IncompleteRun {
  readonly session: SessionSummary;
  readonly incompleteReason?: IncompleteReason;
}

/** A conversation whose judge threw, paired with the error, for the summary. */
export interface SweepFailure {
  readonly session: SessionSummary;
  readonly error: Error;
}

/**
 * The accounting for one sweep. `judged` is every conversation whose judge
 * resolved (the honest aggregate); `complete`, `signalsOnly`, and `incomplete`
 * partition that aggregate by how each run finished. `failed` are the judges that
 * threw a transient or judge-unavailable error (continue-on-error, still
 * retriable); `missingTranscript` are the ones whose transcript was confirmed
 * gone and durably marked so later sweeps skip them; `skipped` were selected but
 * never attempted because the engineer quit between batches.
 */
export interface SweepSummary {
  readonly judged: readonly SessionSummary[];
  readonly complete: readonly SessionSummary[];
  readonly signalsOnly: readonly SessionSummary[];
  readonly incomplete: readonly IncompleteRun[];
  readonly failed: readonly SweepFailure[];
  readonly skipped: readonly SessionSummary[];
  /**
   * Sessions this sweep confirmed had no transcript on disk and durably marked
   * so future sweeps skip them (distinct from `failed`, which is a transient or
   * judge-unavailable throw that may succeed on a later run). Because selection
   * already excludes previously-marked sessions, this bucket is exactly the
   * newly-marked-this-run set.
   */
  readonly missingTranscript: readonly SessionSummary[];
}

/** Inputs to {@link runSweep}; judge, decision, and clock are injected. */
export interface RunSweepOptions {
  readonly filter: SessionFilter;
  readonly force: boolean;
  /** Conversations to judge per batch; must be a positive integer. */
  readonly batchSize: number;
  /**
   * A hard cap on how many conversations this sweep judges (ADR-0018's nightly
   * limit). When set, the cap keeps the conversations closest to aging out,
   * oldest last event first, because a transcript that disappears takes its
   * only chance at a verdict with it. Omitted means no cap.
   */
  readonly limit?: number;
  /**
   * Judge one conversation; resolve with how the run finished (a bare
   * {@link SweepOutcome}, a {@link SweepJudgeResolution} carrying the
   * incomplete reason, or void, taken as `complete`), throw to record a
   * failure.
   */
  readonly judge: (
    session: SessionSummary,
  ) => Promise<SweepOutcome | SweepJudgeResolution | void>;
  /** Decide whether to keep going; called only between batches. */
  readonly decideNextBatch: () => Promise<BatchDecision>;
  /**
   * Also re-judge an already-judged conversation that has grown past its
   * verdict's watermark (ADR-0018). Off by default.
   */
  readonly growth?: boolean;
  readonly now?: () => number;
}

/**
 * Run a bulk-judging sweep: select the conversations, judge them in batches of
 * `batchSize`, and pause between batches for {@link RunSweepOptions.decideNextBatch}.
 * The first batch always runs (invoking the sweep is the opt-in). Returns the
 * per-conversation accounting; never throws for a single failed judge.
 */
export async function runSweep(
  db: Database,
  options: RunSweepOptions,
): Promise<SweepSummary> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new RangeError(
      `batchSize must be a positive integer, got ${options.batchSize}`,
    );
  }
  const nowMs = options.now ?? Date.now;
  const matching = selectSessionsToJudge(
    db,
    options.filter,
    {
      force: options.force,
      ...(options.growth === true ? { growth: true } : {}),
    },
    nowMs,
  );
  const selected =
    options.limit === undefined
      ? matching
      : [...matching]
          .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt))
          .slice(0, options.limit);
  const judged: SessionSummary[] = [];
  const complete: SessionSummary[] = [];
  const signalsOnly: SessionSummary[] = [];
  const incomplete: IncompleteRun[] = [];
  const failed: SweepFailure[] = [];
  const skipped: SessionSummary[] = [];
  const missingTranscript: SessionSummary[] = [];
  let runAll = false;
  for (let i = 0; i < selected.length; i += options.batchSize) {
    if (i > 0 && !runAll) {
      const decision = await options.decideNextBatch();
      if (decision === "quit") {
        skipped.push(...selected.slice(i));
        break;
      }
      if (decision === "all") {
        runAll = true;
      }
    }
    for (const session of selected.slice(i, i + options.batchSize)) {
      try {
        const resolved = (await options.judge(session)) ?? "complete";
        const outcome =
          typeof resolved === "string" ? resolved : resolved.outcome;
        judged.push(session);
        if (outcome === "complete") complete.push(session);
        else if (outcome === "signals-only") signalsOnly.push(session);
        else
          incomplete.push({
            session,
            ...(typeof resolved !== "string" &&
            resolved.incompleteReason !== undefined
              ? { incompleteReason: resolved.incompleteReason }
              : {}),
          });
      } catch (caught) {
        // A confirmed-gone transcript is permanent: mark it durably and bucket
        // it apart from generic failures so future selection skips it. Every
        // other throw (transient, judge-unavailable) stays retriable in `failed`.
        if (caught instanceof TranscriptNotFoundError) {
          markTranscriptMissing(
            db,
            session.sessionId,
            new Date(nowMs()).toISOString(),
          );
          missingTranscript.push(session);
          continue;
        }
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        failed.push({ session, error });
      }
    }
  }
  return {
    judged,
    complete,
    signalsOnly,
    incomplete,
    failed,
    skipped,
    missingTranscript,
  };
}
