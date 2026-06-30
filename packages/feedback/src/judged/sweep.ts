/**
 * A bulk-judging sweep (`regimen assess --all`): select many conversations,
 * then judge them in batches.
 *
 * `selectSessionsToJudge` narrows {@link listSessions} to the conversations a
 * sweep should actually judge: by default the ones not yet judged, or every
 * matching conversation when `force` is set (a re-judge after the judging
 * mechanism itself changed). It is `listSessions` plus a `judged` predicate, no
 * new query and no judged-layer dependency: pure selection over the same read.
 *
 * `runSweep` drives that selection through an injected per-conversation judge
 * in batches, pausing between batches for an injected decision (continue / run
 * all remaining / quit). Judge, decision, and clock are all injected, so the
 * engine is exercised with zero real LLM calls and zero terminal. It is
 * sequential and continue-on-error: a conversation whose judge throws is
 * recorded and the sweep moves on, and because already-judged conversations are
 * excluded by selection, a quit-then-rerun resumes for free.
 */
import type { Database } from "bun:sqlite";
import {
  listSessions,
  type SessionFilter,
  type SessionSummary,
} from "../sessions.ts";

/** Options governing which matching conversations a sweep selects. */
export interface SelectOptions {
  /** Re-judge already-judged conversations too, instead of skipping them. */
  readonly force: boolean;
}

/**
 * Select the conversations a sweep should judge. With `force: false` (default
 * sweep behavior) this is the unjudged subset of the filtered conversations;
 * with `force: true` it is every matching conversation.
 */
export function selectSessionsToJudge(
  db: Database,
  filter: SessionFilter,
  options: SelectOptions,
  now: () => number = Date.now,
): SessionSummary[] {
  return listSessions(db, filter, now).filter(
    (session) => options.force || !session.judged,
  );
}

/**
 * The choice made between batches of a sweep: judge the next batch, judge all
 * remaining batches without pausing again, or stop now and leave the rest.
 */
export type BatchDecision = "continue" | "all" | "quit";

/** A conversation whose judge threw, paired with the error, for the summary. */
export interface SweepFailure {
  readonly session: SessionSummary;
  readonly error: Error;
}

/**
 * The accounting for one sweep: conversations whose judge resolved, those whose
 * judge threw (continue-on-error), and those selected but never attempted
 * because the engineer quit between batches.
 */
export interface SweepSummary {
  readonly judged: readonly SessionSummary[];
  readonly failed: readonly SweepFailure[];
  readonly skipped: readonly SessionSummary[];
}

/** Inputs to {@link runSweep}; judge, decision, and clock are injected. */
export interface RunSweepOptions {
  readonly filter: SessionFilter;
  readonly force: boolean;
  /** Conversations to judge per batch; must be a positive integer. */
  readonly batchSize: number;
  /** Judge one conversation; resolve on success, throw to record a failure. */
  readonly judge: (session: SessionSummary) => Promise<void>;
  /** Decide whether to keep going; called only between batches. */
  readonly decideNextBatch: () => Promise<BatchDecision>;
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
  const selected = selectSessionsToJudge(
    db,
    options.filter,
    { force: options.force },
    options.now,
  );
  const judged: SessionSummary[] = [];
  const failed: SweepFailure[] = [];
  const skipped: SessionSummary[] = [];
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
        await options.judge(session);
        judged.push(session);
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        failed.push({ session, error });
      }
    }
  }
  return { judged, failed, skipped };
}
