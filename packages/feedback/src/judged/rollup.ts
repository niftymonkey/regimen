/**
 * The verdict-rollup read side: the DETERMINISTIC header (capability 1).
 *
 * A cross-conversation read over the per-conversation verdicts already in the
 * store. This module owns the source-of-truth NUMBERS: the count of judged
 * conversations and a per-signal value distribution, computed straight from SQL
 * over the judged set. The synthesis layer (a later slice) reads these numbers
 * plus the assessment prose and interprets them, but it never recomputes a
 * count: the model miscounts buckets, so every number the rollup reports comes
 * from here, never from the model (the SQL-vs-model split).
 *
 * Generalized per ADR-0017: the header is no longer only an Outcome tally. Every
 * always-on signal must be a trustworthy number for both consumers, so the
 * header groups the judged rows by `signal_name` and `value`, returning one
 * distribution per signal. Pure SQLite read: no Judge, no network, no writes.
 */
import type { Database } from "bun:sqlite";
import {
  listSessions,
  type SessionFilter,
  type SessionSummary,
} from "../sessions.ts";

/** One bucket of a signal's distribution: a value and how many verdicts hold it. */
export interface SignalBucket {
  readonly value: string;
  readonly count: number;
}

/** One signal's value distribution across the judged set. */
export interface SignalDistribution {
  readonly signalName: string;
  readonly buckets: ReadonlyArray<SignalBucket>;
}

/**
 * The deterministic head of a verdict rollup: the total judged conversations and
 * a value distribution per emitted signal. Every number a rollup reports comes
 * from here.
 */
export interface RollupHeader {
  readonly totalJudged: number;
  readonly distributions: ReadonlyArray<SignalDistribution>;
}

/**
 * The derived Outcome values in ordinal order, worst to best (ADR-0017). The
 * outcome distribution lists present values in this order; any value outside it
 * (an old pre-re-sweep verdict, or a future vocabulary member) sorts after, by
 * name. Every other signal's buckets sort by value name.
 */
const OUTCOME_ORDER: readonly string[] = [
  "not-accomplished",
  "partial",
  "accomplished-under-heavy-correction",
  "accomplished-under-light-correction",
  "accomplished-cleanly",
];

/**
 * Select the judged conversations matching `filter`: the judged subset of
 * {@link listSessions}, symmetric with the sweep's unjudged selection (the sweep
 * keeps the unjudged, the rollup keeps the judged). Widening past harness/model
 * to the full `SessionFilter` gives the rollup its time window (`since`/`until`)
 * and outcome slice through the one resolver `listSessions` already owns, so no
 * time-filtering is reimplemented and `listJudgedSessions` never learns
 * since/until. `now` resolves the relative bounds. The single selection seam both
 * the header and {@link collectVerdicts} share, so their sets cannot diverge.
 */
export function selectJudged(
  db: Database,
  filter?: SessionFilter,
  now: () => number = Date.now,
): ReadonlyArray<SessionSummary> {
  return listSessions(db, filter ?? {}, now).filter((s) => s.judged);
}

/**
 * Read the deterministic header for the judged conversations matching `filter`.
 * Selection is {@link selectJudged} (the judged subset of `listSessions`), so the
 * header honors the same time window and slice as the verdicts it heads; the
 * distributions come from a single GROUP BY over the judged rows of exactly that
 * set. Every number here comes straight from SQL.
 */
export function rollupHeader(
  db: Database,
  filter?: SessionFilter,
  now: () => number = Date.now,
): RollupHeader {
  const sessionIds = selectJudged(db, filter, now).map((s) => s.sessionId);
  if (sessionIds.length === 0) return { totalJudged: 0, distributions: [] };

  const placeholders = sessionIds.map(() => "?").join(", ");
  // The writer supersede leaves only the latest run's rows in judged_signal, so
  // grouping the selected sessions' rows is the latest verdict per session.
  // json-decode each value to compare and report it plainly.
  const rows = db
    .prepare(
      `SELECT signal_name AS signal_name, value AS value, COUNT(*) AS n
         FROM judged_signal
        WHERE session_id IN (${placeholders})
        GROUP BY signal_name, value`,
    )
    .all(...sessionIds) as ReadonlyArray<{
    signal_name: string;
    value: string;
    n: number;
  }>;

  const bySignal = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const value = JSON.parse(row.value) as string;
    const buckets = bySignal.get(row.signal_name) ?? new Map<string, number>();
    buckets.set(value, row.n);
    bySignal.set(row.signal_name, buckets);
  }

  const distributions = [...bySignal.keys()].sort().map((signalName) => ({
    signalName,
    buckets: orderBuckets(signalName, bySignal.get(signalName)!),
  }));

  return { totalJudged: sessionIds.length, distributions };
}

/**
 * Order one signal's buckets deterministically: the outcome distribution by the
 * worst-to-best {@link OUTCOME_ORDER} (unknown values after, by name), every
 * other signal by value name.
 */
function orderBuckets(
  signalName: string,
  counts: Map<string, number>,
): ReadonlyArray<SignalBucket> {
  const values =
    signalName === "outcome"
      ? [
          ...OUTCOME_ORDER.filter((value) => counts.has(value)),
          ...[...counts.keys()]
            .filter((value) => !OUTCOME_ORDER.includes(value))
            .sort(),
        ]
      : [...counts.keys()].sort();
  return values.map((value) => ({ value, count: counts.get(value)! }));
}
