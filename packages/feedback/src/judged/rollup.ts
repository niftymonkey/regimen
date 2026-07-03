/**
 * The verdict-rollup read side: the DETERMINISTIC header (capability 1).
 *
 * A cross-conversation read over the per-conversation verdicts already in the
 * store. This module owns the source-of-truth NUMBERS: the count of judged
 * conversations and their Outcome distribution, computed straight from SQL by
 * reusing {@link listJudgedSessions}. The synthesis layer (a later slice) reads
 * these numbers plus the assessment prose and interprets them, but it never
 * recomputes a count: the model miscounts buckets, so every number the rollup
 * reports comes from here, never from the model (the SQL-vs-model split).
 *
 * Pure SQLite read: no Judge, no network, no writes, no schema change.
 */
import type { Database } from "bun:sqlite";
import { listJudgedSessions, type JudgedSessionFilter } from "./slice.ts";

/** One bucket of the Outcome distribution: a value and how many verdicts hold it. */
export interface OutcomeTally {
  readonly outcome: string;
  readonly count: number;
}

/**
 * The deterministic head of a verdict rollup: the total judged conversations and
 * their Outcome distribution. Every number a rollup reports comes from here.
 */
export interface RollupHeader {
  readonly totalJudged: number;
  readonly distribution: ReadonlyArray<OutcomeTally>;
}

/**
 * The Outcome values in ordinal order, worst to best (ADR-0008). The
 * distribution lists present outcomes in this order; any value outside it (an
 * unscored/incomplete run, or a future vocabulary member) sorts after, by name.
 */
const OUTCOME_ORDER: readonly string[] = [
  "abandoned",
  "partial",
  "accomplished-with-correction",
  "accomplished-cleanly",
];

/**
 * Read the deterministic header for the judged conversations matching `filter`.
 * Reuses {@link listJudgedSessions} for selection, then tallies the Outcome
 * values it returns. Every number here comes straight from SQL.
 */
export function rollupHeader(
  db: Database,
  filter?: JudgedSessionFilter,
): RollupHeader {
  const sessions = listJudgedSessions(db, filter);
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const outcome = session.outcome ?? "(unscored)";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const ordered = [
    ...OUTCOME_ORDER.filter((outcome) => counts.has(outcome)),
    ...[...counts.keys()].filter((o) => !OUTCOME_ORDER.includes(o)).sort(),
  ];
  return {
    totalJudged: sessions.length,
    distribution: ordered.map((outcome) => ({
      outcome,
      count: counts.get(outcome) ?? 0,
    })),
  };
}
