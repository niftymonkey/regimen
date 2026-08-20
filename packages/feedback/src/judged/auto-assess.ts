/**
 * The due rule for the nightly automatic sweep (ADR-0018).
 *
 * A nightly sweep judges a conversation that has never been judged, and
 * re-judges one that has grown past what its verdict covered. The watermark
 * that makes the second case possible is written by `writeAssessment` at judge
 * time (migration 11); this module reads it back and decides whether the growth
 * since then is worth a second call.
 */
import type { Database } from "bun:sqlite";

/** The fewest new events that can make a re-judge worthwhile, at any length. */
const GROWTH_FLOOR = 20;

/** The share of an already-covered conversation that new events must reach. */
const GROWTH_FRACTION = 0.25;

/**
 * Whether a conversation has grown enough since its last verdict to be worth a
 * second judge call.
 */
export function hasGrownPastWatermark(
  coveredEventCount: number | null,
  currentEventCount: number,
): boolean {
  if (coveredEventCount === null) return false;
  const threshold = Math.max(GROWTH_FLOOR, coveredEventCount * GROWTH_FRACTION);
  return currentEventCount - coveredEventCount >= threshold;
}

/**
 * The covered event count of each session's most recent run, by session id.
 * A session judged before migration 11 has a null count, which the growth rule
 * reads as "no watermark, so no evidence of growth".
 */
export function readCoverageWatermarks(
  db: Database,
): Map<string, number | null> {
  const rows = db
    .prepare(
      `SELECT session_id, covered_event_count
         FROM (SELECT session_id,
                      covered_event_count,
                      ROW_NUMBER() OVER (
                        PARTITION BY session_id
                        ORDER BY created_at DESC, run_id DESC
                      ) AS rank_in_session
                 FROM assessment_run)
        WHERE rank_in_session = 1`,
    )
    .all() as ReadonlyArray<{
    session_id: string;
    covered_event_count: number | null;
  }>;
  return new Map(rows.map((row) => [row.session_id, row.covered_event_count]));
}
