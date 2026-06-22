/**
 * The session-selection read side of the Feedback store (B.4).
 *
 * `listSessions` enumerates conversations by harness, model, time window, and
 * outcome, spanning BOTH judged and unjudged sessions, so the in-session agent
 * has a stable, tested call for "this week's gemini sessions" instead of a
 * hand-rolled query. It is the inverse of an answer command: pure selection,
 * data only. The agent composes everything downstream.
 *
 * Pure SQLite read: no Judge, no network, no writes, no schema change. The
 * `conversations` table is the spine (one row per session, judged or not); the
 * judged-layer tables (`narrative`, `judged_signal`) are LEFT-joined so a never-
 * judged conversation still appears with `judged: false` and a null outcome.
 * Unlike `judged/slice.ts`, which is judged-only, this read spans the whole set.
 */
import type { Database } from "bun:sqlite";

/**
 * One session in a {@link listSessions} result: its id, the harness/model it
 * ran under, its lifecycle bounds, how many events it holds, whether it carries
 * a persisted assessment narrative, and the whole-conversation outcome value
 * when judged (else null). `outcome` is a plain string, not the judged
 * vocabulary, so this read stays agnostic of the judged layer's enum.
 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly harness: string;
  readonly model: string | null;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventCount: number;
  readonly judged: boolean;
  readonly outcome: string | null;
}

/**
 * Filter for {@link listSessions}: any combination is optional, and no filter
 * means all sessions. `since`/`until` bound a session by its MOST-RECENT event
 * timestamp (`lastEventAt`) and accept either an ISO date (`YYYY-MM-DD`) or a
 * relative offset `Nd`/`Nh` (days/hours before now).
 */
export interface SessionFilter {
  readonly harness?: string;
  readonly model?: string;
  readonly since?: string;
  readonly until?: string;
  readonly outcome?: string;
}

/** Which edge of the window a bound resolves: `since` opens it, `until` closes it. */
type BoundEdge = "since" | "until";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE = /^(\d+)([dh])$/;

/**
 * Resolve a `since`/`until` value to an ISO-8601 UTC instant for comparison
 * against `last_event_at`. Accepts a bare ISO date (`YYYY-MM-DD`) or a relative
 * offset `Nd`/`Nh` (days/hours before `nowMs`). A bare `until` date resolves to
 * the END of that day so the whole day is inside an inclusive `<=` window; a
 * bare `since` date resolves to the start of the day. Throws on an unparseable
 * value so the caller can surface a clear error rather than silently matching
 * nothing.
 */
function resolveBound(value: string, edge: BoundEdge, nowMs: number): string {
  const relative = RELATIVE.exec(value);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "d" ? 86_400_000 : 3_600_000;
    return new Date(nowMs - amount * unitMs).toISOString();
  }
  if (ISO_DATE.test(value)) {
    const dayMs = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(dayMs)) {
      throw new Error(`invalid date for ${edge}: ${value}`);
    }
    const instant = edge === "until" ? dayMs + 86_400_000 - 1 : dayMs;
    return new Date(instant).toISOString();
  }
  throw new Error(
    `could not parse ${edge}: ${value}; use an ISO date (YYYY-MM-DD) or a relative offset like 7d or 12h`,
  );
}

/**
 * List one row per session matching the filter, newest `lastEventAt` first.
 * Spans judged and unjudged conversations alike. Pure read; throws only when a
 * `since`/`until` value cannot be parsed.
 */
export function listSessions(
  db: Database,
  filter: SessionFilter = {},
  now: () => number = Date.now,
): ReadonlyArray<SessionSummary> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.harness !== undefined) {
    clauses.push("c.harness = ?");
    params.push(filter.harness);
  }
  if (filter.model !== undefined) {
    clauses.push("c.model = ?");
    params.push(filter.model);
  }
  if (filter.outcome !== undefined) {
    // judged_signal.value is JSON-encoded by the writer, so an outcome of
    // `partial` is stored as the text `"partial"`. json_quote encodes the bind
    // param the same way, so the comparison matches the stored encoding.
    clauses.push("s.value = json_quote(?)");
    params.push(filter.outcome);
  }
  if (filter.since !== undefined) {
    clauses.push("c.last_event_at >= ?");
    params.push(resolveBound(filter.since, "since", now()));
  }
  if (filter.until !== undefined) {
    clauses.push("c.last_event_at <= ?");
    params.push(resolveBound(filter.until, "until", now()));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT
         c.session_id   AS session_id,
         c.harness      AS harness,
         c.model        AS model,
         c.first_event_at AS first_event_at,
         c.last_event_at  AS last_event_at,
         COALESCE(cc.event_count, 0) AS event_count,
         n.session_id IS NOT NULL AS judged,
         s.value AS outcome
       FROM conversations c
       LEFT JOIN conversation_counts cc USING (session_id)
       LEFT JOIN narrative n
         ON n.session_id = c.session_id AND n.narrative_type = 'assessment'
       LEFT JOIN judged_signal s
         ON s.session_id = c.session_id AND s.signal_name = 'outcome'
       ${where}
       ORDER BY c.last_event_at DESC, c.session_id ASC`,
    )
    .all(...params) as ReadonlyArray<SessionRow>;

  return rows.map(toSummary);
}

interface SessionRow {
  session_id: string;
  harness: string;
  model: string | null;
  first_event_at: string;
  last_event_at: string;
  event_count: number;
  judged: number;
  outcome: string | null;
}

function toSummary(row: SessionRow): SessionSummary {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    model: row.model,
    firstEventAt: row.first_event_at,
    lastEventAt: row.last_event_at,
    eventCount: row.event_count,
    judged: row.judged === 1,
    outcome: row.outcome === null ? null : (JSON.parse(row.outcome) as string),
  };
}
