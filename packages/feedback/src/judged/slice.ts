/**
 * The read-time harness/model slice on the judged store (B.1, ADR-0008).
 *
 * Per ADR-0008 harness and model are deliberately kept OFF the judged rows and
 * recovered as read-time slice dimensions by joining the `conversations` table
 * on `session_id`. This module owns that recovery in one place: a pure join
 * helper every judged read can share, and a harness/model-sliced listing that
 * lets a reader group and compare judged sessions by harness (and model).
 *
 * Pure SQLite read: no Judge, no network, no writes, no schema change.
 */
import type { Database } from "bun:sqlite";

/** A session's read-time slice dimensions recovered from `conversations`. */
export interface SessionHarnessModel {
  readonly harness: string;
  readonly model: string | null;
}

/**
 * One judged session in the harness/model-sliced listing: its id, the slice
 * dimensions recovered by join, whether its latest run finished clean, and the
 * whole-conversation Outcome value when the run surfaced one.
 */
export interface JudgedSessionSummary {
  readonly sessionId: string;
  readonly harness: string;
  readonly model: string | null;
  readonly complete: boolean;
  readonly outcome: string | null;
}

/** Filter for {@link listJudgedSessions}: any combination of harness and model. */
export interface JudgedSessionFilter {
  readonly harness?: string;
  readonly model?: string;
}

/**
 * Recover a session's slice dimensions from `conversations`, or null when no
 * conversation row exists for the id. The single source of the read-time
 * harness/model recovery (ADR-0008).
 */
export function sessionHarnessModel(
  db: Database,
  sessionId: string,
): SessionHarnessModel | null {
  const row = db
    .prepare(`SELECT harness, model FROM conversations WHERE session_id = ?`)
    .get(sessionId) as { harness: string; model: string | null } | null;
  if (!row) return null;
  return { harness: row.harness, model: row.model };
}

/**
 * List one row per JUDGED session (a session with a latest assessment_run),
 * joined to `conversations` for its harness/model and carrying the
 * whole-conversation Outcome value, optionally filtered by harness and/or
 * model. Unjudged sessions are excluded. Ordered deterministically.
 */
export function listJudgedSessions(
  db: Database,
  filter?: JudgedSessionFilter,
): ReadonlyArray<JudgedSessionSummary> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.harness !== undefined) {
    clauses.push("c.harness = ?");
    params.push(filter.harness);
  }
  if (filter?.model !== undefined) {
    clauses.push("c.model = ?");
    params.push(filter.model);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT
         r.session_id AS session_id,
         c.harness AS harness,
         c.model AS model,
         r.complete AS complete,
         s.value AS outcome
       FROM (
         SELECT session_id, complete
           FROM assessment_run a
          WHERE a.created_at = (
                  SELECT MAX(b.created_at) FROM assessment_run b
                   WHERE b.session_id = a.session_id
                )
            AND a.run_id = (
                  SELECT b.run_id FROM assessment_run b
                   WHERE b.session_id = a.session_id
                     AND b.created_at = a.created_at
                   ORDER BY b.run_id DESC LIMIT 1
                )
       ) AS r
       JOIN conversations c USING (session_id)
       LEFT JOIN judged_signal s
         ON s.session_id = r.session_id AND s.signal_name = 'outcome'
       ${where}
       ORDER BY r.session_id ASC`,
    )
    .all(...params) as ReadonlyArray<{
    session_id: string;
    harness: string;
    model: string | null;
    complete: number;
    outcome: string | null;
  }>;

  return rows.map((row) => ({
    sessionId: row.session_id,
    harness: row.harness,
    model: row.model,
    complete: row.complete === 1,
    outcome: row.outcome === null ? null : (JSON.parse(row.outcome) as string),
  }));
}
