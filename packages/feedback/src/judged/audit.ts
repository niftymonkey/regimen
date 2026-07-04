/**
 * The leverage audit read side: the DETERMINISTIC core (ADR-0016 capability 2).
 *
 * Where the verdict rollup (rollup.ts) aggregates how conversations went, the
 * leverage audit asks whether the engineer's own established practices are
 * actually honored across conversations. This module owns the source-of-truth
 * NUMBERS: per practice, how many conversations it was IN FORCE for and how many
 * of those it actually FIRED in, plus the convention-adherence distribution, all
 * straight from SQL over the store. The synthesis layer (audit-synthesis.ts)
 * interprets these numbers into prose but never recomputes one.
 *
 * Time-scoping (ADR-0016) is structural, not a date comparison: a practice is
 * ELIGIBLE for a conversation only when that conversation's own setup snapshot
 * (`conversation_setup_snapshot`, migration v7, captured at the conversation's
 * time) lists the practice. A conversation that predates a practice never carried
 * it in its snapshot roster, so it is never eligible and a non-firing there can
 * never count against the practice. Firing is the deterministic evidence-layer
 * fact `skill_invocations` (migration v3) already records.
 *
 * Pure SQLite read: no Judge, no network, no writes, no schema change.
 */
import type { Database } from "bun:sqlite";

/** A practice's liveness class over the audited window (leverage-audit terms). */
export type LeverHealth = "working" | "idle" | "too-new";

/** One practice's deterministic liveness read across the audited conversations. */
export interface LeverReport {
  /** The practice name, as it appears in both the snapshot roster and firing. */
  readonly name: string;
  /** Conversations that carried this practice in their setup snapshot (in force). */
  readonly eligibleSessions: number;
  /** Of the eligible conversations, how many the practice actually fired in. */
  readonly firedSessions: number;
  /** working (fires), idle (in force enough but silent), too-new (too few in force). */
  readonly health: LeverHealth;
  /** Whether the practice is still in the engineer's current live setup. */
  readonly inForceNow: boolean;
}

/** One bucket of the convention-adherence distribution: a value and its count. */
export interface AdherenceBucket {
  readonly value: string;
  readonly count: number;
}

/**
 * The convention half of the leverage read: how the AI honored the engineer's
 * stated conventions across the audited conversations, as the sliceable
 * `convention-adherence` judged-signal distribution (abstention when none were in
 * force means those conversations simply carry no row).
 */
export interface ConventionAdherenceReport {
  readonly buckets: ReadonlyArray<AdherenceBucket>;
}

/** The whole deterministic leverage-audit read: per-practice liveness + conventions. */
export interface LeverageAuditReport {
  readonly levers: ReadonlyArray<LeverReport>;
  readonly conventionAdherence: ConventionAdherenceReport;
}

/** The audited window: harness/model slice plus an optional conversation-time bound. */
export interface AuditFilter {
  readonly harness?: string;
  readonly model?: string;
  /** ISO lower bound on the conversation's snapshot time (inclusive). */
  readonly since?: string;
  /** ISO upper bound on the conversation's snapshot time (inclusive). */
  readonly until?: string;
}

export interface AuditOptions {
  readonly filter?: AuditFilter;
  /**
   * The practice names currently in force, read from the live setup source by the
   * caller. A practice here that no snapshot ever carried is brand new and reads
   * as too-new (zero eligible); it also marks `inForceNow` on any practice.
   */
  readonly currentLevers?: ReadonlyArray<string>;
  /**
   * The eligibility floor below which a practice is too-new to judge (not enough
   * conversations have carried it to call it idle). Defaults to {@link DEFAULT_MIN_ELIGIBLE}.
   */
  readonly minEligible?: number;
}

/** A practice needs at least this many eligible conversations before idle is a fair call. */
export const DEFAULT_MIN_ELIGIBLE = 3;

export function leverageAudit(
  db: Database,
  options: AuditOptions = {},
): LeverageAuditReport {
  const filter = options.filter ?? {};
  const currentLevers = new Set(options.currentLevers ?? []);
  const minEligible = options.minEligible ?? DEFAULT_MIN_ELIGIBLE;

  const snapshots = readSnapshots(db, filter);
  const fired = readFiring(db, filter);

  // The practice universe: every name any snapshot carried, plus every name the
  // live setup source reports in force now (a brand-new practice no snapshot has
  // carried yet still gets a too-new row).
  const names = new Set<string>();
  for (const snap of snapshots) {
    for (const name of snap.practices) names.add(name);
  }
  for (const name of currentLevers) names.add(name);

  const levers: LeverReport[] = [...names].sort().map((name) => {
    const eligible = snapshots.filter((snap) => snap.practices.includes(name));
    const firedSessions = eligible.filter((snap) =>
      fired.get(snap.sessionId)?.has(name),
    ).length;
    return {
      name,
      eligibleSessions: eligible.length,
      firedSessions,
      health: classify(eligible.length, firedSessions, minEligible),
      inForceNow: currentLevers.has(name),
    };
  });

  return {
    levers,
    conventionAdherence: { buckets: readAdherence(db, filter) },
  };
}

/**
 * Read the convention-adherence distribution across the windowed conversations:
 * one bucket per emitted value (followed / partially-followed / violated),
 * ordered by value name. Conversations with no conventions in force abstained
 * (no row), so they never enter the count. This is the sliceable "conventions
 * honored" rate the design's leverage read composes (a number prose cannot give).
 */
function readAdherence(
  db: Database,
  filter: AuditFilter,
): ReadonlyArray<AdherenceBucket> {
  const { clauses, params } = sliceClauses(filter, "i");
  clauses.push("s.signal_name = 'convention-adherence'");
  const rows = db
    .prepare(
      `SELECT s.value AS value, COUNT(*) AS n
         FROM judged_signal s
         JOIN conversations c USING (session_id)
         WHERE ${clauses.join(" AND ")}
         GROUP BY s.value`,
    )
    .all(...params) as ReadonlyArray<{ value: string; n: number }>;
  return rows
    .map((row) => ({ value: JSON.parse(row.value) as string, count: row.n }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Classify a practice's liveness: too-new when too few conversations have carried
 * it to fairly call it idle, idle when it was in force enough but never fired
 * (the silent non-firing the audit exists for), working when it fired at all.
 */
function classify(
  eligible: number,
  firedSessions: number,
  minEligible: number,
): LeverHealth {
  if (eligible < minEligible) return "too-new";
  if (firedSessions === 0) return "idle";
  return "working";
}

/** One conversation's setup snapshot: its id and the practice roster in force. */
interface SnapshotRow {
  readonly sessionId: string;
  readonly practices: ReadonlyArray<string>;
}

/**
 * Read every conversation's setup snapshot within the window, parsing the
 * practice roster (`[{ name }]`). The window filters conversations by their
 * snapshot's captured-at time (the conversation's own asOf) and by harness/model
 * via the join to `conversations`. This is the time-scoping seam: a conversation
 * that predates a practice never carried it here.
 */
function readSnapshots(
  db: Database,
  filter: AuditFilter,
): ReadonlyArray<SnapshotRow> {
  const { clauses, params } = sliceClauses(filter, "s");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT s.session_id AS session_id, s.practices AS practices
         FROM conversation_setup_snapshot s
         JOIN conversations c USING (session_id)
         ${where}`,
    )
    .all(...params) as ReadonlyArray<{ session_id: string; practices: string }>;
  return rows.map((row) => ({
    sessionId: row.session_id,
    practices: (
      JSON.parse(row.practices) as ReadonlyArray<{ name: string }>
    ).map((entry) => entry.name),
  }));
}

/**
 * Read the firing facts within the window as a map from session id to the set of
 * practice names that fired in it (`invocation_count > 0`). The evidence layer's
 * `skill_invocations` is the deterministic firing record.
 */
function readFiring(
  db: Database,
  filter: AuditFilter,
): Map<string, Set<string>> {
  const { clauses, params } = sliceClauses(filter, "i");
  clauses.push("i.invocation_count > 0");
  const rows = db
    .prepare(
      `SELECT i.session_id AS session_id, i.skill_name AS skill_name
         FROM skill_invocations i
         JOIN conversations c USING (session_id)
         WHERE ${clauses.join(" AND ")}`,
    )
    .all(...params) as ReadonlyArray<{
    session_id: string;
    skill_name: string;
  }>;
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = map.get(row.session_id) ?? new Set<string>();
    set.add(row.skill_name);
    map.set(row.session_id, set);
  }
  return map;
}

/**
 * The shared harness/model/window predicates for a read joined to `conversations`
 * aliased `c`. The time bounds compare the snapshot's captured-at for the snapshot
 * read (`primary = "s"`) and the conversation's last-event time for the firing
 * read (`primary = "i"`), so both windows mean "the conversation happened in
 * range." Returns the clause list so a caller can append its own predicates.
 */
function sliceClauses(
  filter: AuditFilter,
  primary: "s" | "i",
): { clauses: string[]; params: string[] } {
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
  const timeColumn = primary === "s" ? "s.captured_at" : "c.last_event_at";
  if (filter.since !== undefined) {
    clauses.push(`${timeColumn} >= ?`);
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    clauses.push(`${timeColumn} <= ?`);
    params.push(filter.until);
  }
  return { clauses, params };
}
