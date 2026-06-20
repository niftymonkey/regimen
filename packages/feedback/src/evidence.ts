/**
 * The evidence-layer read side of the Feedback store.
 *
 * `readEvidenceDigest` reads the deterministic signal tables for one
 * conversation and shapes them into an `EvidenceDigest`: the named
 * evidence-layer signals an in-session skill pulls back into the agent's
 * context so it can self-correct. The digest is facts only, with no
 * judgment or interpretation; turning counts into a verdict is the Phase 2
 * judgment layer's job (ADR-0005, ADR-0006, docs/feedback-surfacing.md).
 *
 * The `EvidenceDigest` type is also the wire contract: the `feedback
 * evidence` CLI JSON.stringifies it to stdout with no formatting step.
 * `store.ts` owns the writer side of the same SQLite store; this module
 * only reads and never writes.
 */
import type { Database } from "bun:sqlite";

/**
 * The evidence-layer signals for one conversation. A discriminated union on
 * `known`: an unknown session (no conversations row, the daemon has not
 * drained anything for it yet) is a genuinely different shape, never the
 * known shape with empty placeholders.
 */
export type EvidenceDigest =
  | UnknownConversationDigest
  | KnownConversationDigest;

/** The store has no conversations row for this session id. */
export interface UnknownConversationDigest {
  schemaVersion: 1;
  /** ISO-8601 UTC instant the digest was computed, from the injected clock. */
  generatedAt: string;
  /** The opaque harness session id, echoed back. */
  sessionId: string;
  known: false;
  /** Why there is nothing to report. */
  note: string;
}

/** The store has a conversations row; every signal is measured. */
export interface KnownConversationDigest {
  schemaVersion: 1;
  generatedAt: string;
  sessionId: string;
  known: true;
  conversation: ConversationFacet;
  staleness: Staleness;
  counts: ConversationCounts;
  toolMix: ReadonlyArray<ToolMixEntry>;
  skillUsage: ReadonlyArray<SkillUsageEntry>;
  repeatedFileEdits: ReadonlyArray<RepeatedFileEdit>;
  gateDenials: ReadonlyArray<GateDenial>;
}

/** The conversation's identity and lifecycle timestamps. */
export interface ConversationFacet {
  harness: string;
  model: string | null;
  /**
   * The working directory the session ran in, the per-conversation anchor for
   * which body of work it belongs to. null when no event carried one (the
   * harness did not report it, or the conversation predates cwd capture),
   * never a fabricated or default path.
   */
  cwd: string | null;
  /** session_started_at; null when no session.start event has been drained. */
  startedAt: string | null;
  firstEventAt: string;
  lastEventAt: string;
  /** session_ended_at; null while the conversation is open, never imputed. */
  endedAt: string | null;
}

/** How long the conversation has been open and how idle it has gone. */
export interface Staleness {
  /** now minus startedAt, in ms; null when startedAt is null. */
  openMs: number | null;
  /** now minus lastEventAt, in ms. */
  idleMs: number;
}

/** Single-event counts from the conversation_counts view. */
export interface ConversationCounts {
  promptCount: number;
  toolCallCount: number;
  compactionCount: number;
  gateDenialCount: number;
  eventCount: number;
}

/** One distinct tool and how many times it was called this conversation. */
export interface ToolMixEntry {
  toolName: string;
  callCount: number;
}

/** One distinct skill and how many times it was invoked this conversation. */
export interface SkillUsageEntry {
  skillName: string;
  invocationCount: number;
  lastInvokedAt: string;
}

/** One file and how many times it was edited this conversation. */
export interface RepeatedFileEdit {
  filePath: string;
  editCount: number;
  lastEditedAt: string;
}

/** One gate denial against this conversation. */
export interface GateDenial {
  toolName: string;
  gateId: string;
  toolCallId: string;
  reason: string | null;
  deniedAt: string;
}

/**
 * Build the digest for a session the store has never seen. Used internally
 * when no conversations row exists, and by the CLI when no store file exists
 * at all, so an unknown session is always a valid, well-typed digest. `note`
 * overrides the default explanation; the harness-specific CLI uses it to
 * report that no current session could be resolved at all.
 */
export function unknownDigest(
  sessionId: string,
  now: () => number = Date.now,
  note = "no events recorded for this session yet",
): UnknownConversationDigest {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    sessionId,
    known: false,
    note,
  };
}

interface ConversationRow {
  harness: string;
  model: string | null;
  cwd: string | null;
  session_started_at: string | null;
  session_ended_at: string | null;
  first_event_at: string;
  last_event_at: string;
}

interface CountsRow {
  prompt_count: number;
  tool_call_count: number;
  compaction_count: number;
  gate_denial_count: number;
  event_count: number;
}

/**
 * Read the single-event counts for a session from the conversation_counts
 * view. A known conversation always has at least one events row (the event
 * that created its conversations row), so the view yields a row; the zero
 * fallback is defensive only.
 */
function readCounts(db: Database, sessionId: string): ConversationCounts {
  const row = db
    .prepare(
      `SELECT prompt_count, tool_call_count, compaction_count,
              gate_denial_count, event_count
         FROM conversation_counts WHERE session_id = ?`,
    )
    .get(sessionId) as CountsRow | null;
  if (!row) {
    return {
      promptCount: 0,
      toolCallCount: 0,
      compactionCount: 0,
      gateDenialCount: 0,
      eventCount: 0,
    };
  }
  return {
    promptCount: row.prompt_count,
    toolCallCount: row.tool_call_count,
    compactionCount: row.compaction_count,
    gateDenialCount: row.gate_denial_count,
    eventCount: row.event_count,
  };
}

interface ToolMixRow {
  tool_name: string;
  call_count: number;
}

/**
 * The tool-call distribution for a session: one entry per distinct tool with
 * its call count, ordered by count descending then tool name, so the digest
 * is byte-stable for a given store state.
 */
function readToolMix(db: Database, sessionId: string): ToolMixEntry[] {
  const rows = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS call_count
         FROM tool_call_spans WHERE session_id = ?
         GROUP BY tool_name
         ORDER BY call_count DESC, tool_name ASC`,
    )
    .all(sessionId) as ToolMixRow[];
  return rows.map((r) => ({ toolName: r.tool_name, callCount: r.call_count }));
}

interface SkillUsageRow {
  skill_name: string;
  invocation_count: number;
  last_invoked_at: string;
}

/**
 * The skill-usage distribution for a session: one entry per distinct skill
 * with its invocation count, ordered by count descending then skill name, so
 * the most-leaned-on skill leads and the digest is byte-stable.
 */
function readSkillUsage(db: Database, sessionId: string): SkillUsageEntry[] {
  const rows = db
    .prepare(
      `SELECT skill_name, invocation_count, last_invoked_at
         FROM skill_invocations WHERE session_id = ?
         ORDER BY invocation_count DESC, skill_name ASC`,
    )
    .all(sessionId) as SkillUsageRow[];
  return rows.map((r) => ({
    skillName: r.skill_name,
    invocationCount: r.invocation_count,
    lastInvokedAt: r.last_invoked_at,
  }));
}

interface RepeatedFileEditRow {
  file_path: string;
  edit_count: number;
  last_edited_at: string;
}

/**
 * The repeated-file-edit churn for a session, ordered by edit count
 * descending then file path, so the most-churned file leads.
 */
function readRepeatedFileEdits(
  db: Database,
  sessionId: string,
): RepeatedFileEdit[] {
  const rows = db
    .prepare(
      `SELECT file_path, edit_count, last_edited_at
         FROM repeated_file_edits WHERE session_id = ?
         ORDER BY edit_count DESC, file_path ASC`,
    )
    .all(sessionId) as RepeatedFileEditRow[];
  return rows.map((r) => ({
    filePath: r.file_path,
    editCount: r.edit_count,
    lastEditedAt: r.last_edited_at,
  }));
}

interface GateDenialRow {
  tool_name: string;
  gate_id: string;
  tool_call_id: string;
  reason: string | null;
  denied_at: string;
}

/**
 * The gate denials against a session, ordered chronologically so the agent
 * reads its denial history in the order it happened.
 */
function readGateDenials(db: Database, sessionId: string): GateDenial[] {
  const rows = db
    .prepare(
      `SELECT tool_name, gate_id, tool_call_id, reason, denied_at
         FROM gate_denials WHERE session_id = ?
         ORDER BY denied_at ASC, gate_id ASC`,
    )
    .all(sessionId) as GateDenialRow[];
  return rows.map((r) => ({
    toolName: r.tool_name,
    gateId: r.gate_id,
    toolCallId: r.tool_call_id,
    reason: r.reason,
    deniedAt: r.denied_at,
  }));
}

/**
 * Read the evidence layer for one conversation and shape it into a digest.
 *
 * Pure read of the local SQLite store: no network, no LLM, no writes. Never
 * throws on an unknown session id or a near-empty conversation; both yield a
 * valid `EvidenceDigest`. `now` is injectable so the staleness fields are
 * deterministic in tests.
 */
export function readEvidenceDigest(
  db: Database,
  sessionId: string,
  now: () => number = Date.now,
): EvidenceDigest {
  const row = db
    .prepare(
      `SELECT harness, model, cwd, session_started_at, session_ended_at,
              first_event_at, last_event_at
         FROM conversations WHERE session_id = ?`,
    )
    .get(sessionId) as ConversationRow | null;
  if (!row) return unknownDigest(sessionId, now);

  const nowMs = now();
  const startedMs =
    row.session_started_at === null ? null : Date.parse(row.session_started_at);

  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    sessionId,
    known: true,
    conversation: {
      harness: row.harness,
      model: row.model,
      cwd: row.cwd,
      startedAt: row.session_started_at,
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
      endedAt: row.session_ended_at,
    },
    staleness: {
      openMs: startedMs === null ? null : nowMs - startedMs,
      idleMs: nowMs - Date.parse(row.last_event_at),
    },
    counts: readCounts(db, sessionId),
    toolMix: readToolMix(db, sessionId),
    skillUsage: readSkillUsage(db, sessionId),
    repeatedFileEdits: readRepeatedFileEdits(db, sessionId),
    gateDenials: readGateDenials(db, sessionId),
  };
}
