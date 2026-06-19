/**
 * The Source: the only module that reads the Feedback SQLite store.
 *
 * It opens `feedback.db` read-only in WAL mode, alongside the loader's writes,
 * and exposes one pull method per OTLP signal stream. Each method takes the
 * stream's watermark and returns a typed batch plus the cursor to resume from.
 * The Source hides SQLite entirely: query templates, the `attributes` JSON
 * column, BLOB-to-hex, and NULL-to-optional translation all live here.
 *
 * The logs cursor is a timestamp plus the set of event_hashes already emitted
 * at exactly that timestamp. Capture timestamps are millisecond-precision and
 * several events can share one; event_hash order is not insertion order, so an
 * event can land at an already-passed millisecond. Each pull therefore
 * re-reads the boundary millisecond and drops the hashes already emitted. The
 * carried set is bounded by the count of events sharing the highest
 * millisecond, which is tiny.
 */
import { Database } from "bun:sqlite";
import type {
  ConversationCountsRow,
  FileEditRow,
  GateDenialRow,
  LogRow,
  LogsBatch,
  MetricsBatch,
  SessionSpanRow,
  ToolSpanRow,
  TracesBatch,
} from "./types.ts";

export interface Source {
  /** New `events` rows since `watermark`, for the logs stream. */
  pullLogs(watermark: string | null): LogsBatch;
  /** Conversation counts and signal rows active since `watermark`. */
  pullMetrics(watermark: string | null): MetricsBatch;
  /** Closed conversations, closed tool calls, and point events since `watermark`. */
  pullTraces(watermark: string | null): TracesBatch;
  /** Release the database handle. */
  close(): void;
}

/** One `events` row as SQLite returns it, with event_hash already hex. */
interface EventRow {
  event_hash: string;
  schema_version: number;
  trace_id: string;
  session_id: string;
  timestamp: string;
  harness: string;
  model: string | null;
  event_type: string;
  span_phase: string;
  span_name: string;
  attributes: string;
}

/**
 * Parse one event's `attributes` JSON. The loader writes this column, but the
 * bridge reads a store another process owns: a single unreadable row degrades
 * to empty attributes rather than stalling the whole logs stream.
 */
function parseAttributes(
  raw: string,
  eventHash: string,
): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    console.error(
      `bridge: unreadable attributes on event ${eventHash}, treating as empty`,
    );
    return {};
  }
}

function toLogRow(row: EventRow): LogRow {
  return {
    eventHash: row.event_hash,
    schemaVersion: row.schema_version,
    traceId: row.trace_id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    harness: row.harness,
    model: row.model,
    eventType: row.event_type,
    spanPhase: row.span_phase,
    spanName: row.span_name,
    attributes: parseAttributes(row.attributes, row.event_hash),
  };
}

/**
 * A cursor over rows ordered by (timestamp, id): the highest timestamp seen
 * and every id already emitted at it. The logs stream and the three trace
 * sub-streams each track emit-once state with one of these.
 */
interface BoundaryCursor {
  ts: string;
  emitted: string[];
}

/**
 * Split rows already ordered by (ts, id) into those not yet emitted and the
 * cursor describing everything now emitted. A row counts as already emitted
 * when it sits on the prior cursor's boundary timestamp and its id is in the
 * prior emitted set. Re-reading the boundary timestamp every call is what
 * stops a row landing at an already-passed millisecond from being skipped.
 */
function advanceBoundary<T>(
  ordered: T[],
  prior: BoundaryCursor | null,
  tsOf: (row: T) => string,
  idOf: (row: T) => string,
): { fresh: T[]; next: BoundaryCursor | null } {
  if (ordered.length === 0) return { fresh: [], next: prior };
  const seen = new Set(prior?.emitted ?? []);
  const fresh = ordered.filter(
    (row) => !(prior !== null && tsOf(row) === prior.ts && seen.has(idOf(row))),
  );
  const ts = tsOf(ordered[ordered.length - 1]!);
  const emitted = ordered.filter((row) => tsOf(row) === ts).map(idOf);
  return { fresh, next: { ts, emitted } };
}

/** The traces watermark: one boundary cursor per span source. */
interface TracesCursor {
  point: BoundaryCursor | null;
  tool: BoundaryCursor | null;
  session: BoundaryCursor | null;
}

const LOG_COLUMNS = `
  lower(hex(event_hash)) AS event_hash, schema_version, trace_id, session_id,
  timestamp, harness, model, event_type, span_phase, span_name, attributes`;

/** One joined `conversation_counts` row as SQLite returns it. */
interface CountsRow {
  session_id: string;
  harness: string;
  model: string | null;
  prompt_count: number;
  tool_call_count: number;
  compaction_count: number;
  gate_denial_count: number;
  last_event_at: string;
}

function toCountsRow(row: CountsRow): ConversationCountsRow {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    model: row.model,
    promptCount: row.prompt_count,
    toolCallCount: row.tool_call_count,
    compactionCount: row.compaction_count,
    gateDenialCount: row.gate_denial_count,
    lastEventAt: row.last_event_at,
  };
}

const COUNTS_SELECT = `
  SELECT c.session_id, c.harness, c.model, c.last_event_at,
         cc.prompt_count, cc.tool_call_count,
         cc.compaction_count, cc.gate_denial_count
  FROM conversation_counts cc
  JOIN conversations c ON c.session_id = cc.session_id`;

/** One joined `repeated_file_edits` row as SQLite returns it. */
interface FileEditQueryRow {
  session_id: string;
  harness: string;
  file_path: string;
  edit_count: number;
  last_edited_at: string;
}

function toFileEditRow(row: FileEditQueryRow): FileEditRow {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    filePath: row.file_path,
    editCount: row.edit_count,
    lastEditedAt: row.last_edited_at,
  };
}

const FILE_EDITS_SELECT = `
  SELECT fe.session_id, c.harness, fe.file_path, fe.edit_count, fe.last_edited_at
  FROM repeated_file_edits fe
  JOIN conversations c ON c.session_id = fe.session_id`;

/** One joined `gate_denials` row as SQLite returns it. */
interface GateDenialQueryRow {
  session_id: string;
  harness: string;
  gate_id: string;
  tool_name: string;
  denied_at: string;
}

function toGateDenialRow(row: GateDenialQueryRow): GateDenialRow {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    gateId: row.gate_id,
    toolName: row.tool_name,
    deniedAt: row.denied_at,
  };
}

const GATE_DENIALS_SELECT = `
  SELECT gd.session_id, c.harness, gd.gate_id, gd.tool_name, gd.denied_at
  FROM gate_denials gd
  JOIN conversations c ON c.session_id = gd.session_id`;

/** One closed `conversations` row joined to its trace id, as SQLite returns it. */
interface SessionSpanQueryRow {
  session_id: string;
  harness: string;
  model: string | null;
  session_started_at: string | null;
  session_ended_at: string;
  trace_id: string;
}

function toSessionSpanRow(row: SessionSpanQueryRow): SessionSpanRow {
  return {
    sessionId: row.session_id,
    traceId: row.trace_id,
    harness: row.harness,
    model: row.model,
    startedAt: row.session_started_at,
    endedAt: row.session_ended_at,
  };
}

/**
 * Only closed conversations (`session_ended_at IS NOT NULL`); an open one is
 * never force-closed into a span. trace_id is not a `conversations` column; it
 * is read from any event of the session (every event of a session shares one
 * trace id), which keeps the session span in the same trace as the
 * event-derived spans without re-deriving the loader's id formula. The EXISTS
 * guard keeps the query to sessions that have at least one event, so the
 * trace_id subquery is always a non-null value.
 */
const SESSION_SPANS_SELECT = `
  SELECT c.session_id, c.harness, c.model,
         c.session_started_at, c.session_ended_at,
         (SELECT e.trace_id FROM events e
            WHERE e.session_id = c.session_id LIMIT 1) AS trace_id
  FROM conversations c
  WHERE c.session_ended_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = c.session_id)`;

/** One closed `tool_call_spans` row joined to its trace id and harness. */
interface ToolSpanQueryRow {
  session_id: string;
  trace_id: string;
  harness: string;
  tool_name: string;
  tool_call_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number | null;
  denied_by_gate_id: string | null;
}

function toToolSpanRow(row: ToolSpanQueryRow): ToolSpanRow {
  return {
    sessionId: row.session_id,
    traceId: row.trace_id,
    harness: row.harness,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    deniedByGateId: row.denied_by_gate_id,
  };
}

/**
 * Only closed tool calls (`ended_at IS NOT NULL`); an open call is skipped.
 * The EXISTS guard keeps the trace_id subquery non-null, as for session spans.
 */
const TOOL_SPANS_SELECT = `
  SELECT t.session_id, c.harness, t.tool_name, t.tool_call_id,
         t.started_at, t.ended_at, t.duration_ms, t.denied_by_gate_id,
         (SELECT e.trace_id FROM events e
            WHERE e.session_id = t.session_id LIMIT 1) AS trace_id
  FROM tool_call_spans t
  JOIN conversations c ON c.session_id = t.session_id
  WHERE t.ended_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = t.session_id)`;

/** The instantaneous events that become point spans, emitted once each. */
const POINT_EVENTS_SELECT = `
  SELECT ${LOG_COLUMNS} FROM events
  WHERE event_type IN ('user_prompt', 'compaction', 'gate.denial')`;

/** Open the Source against the Feedback store at `dbPath`. */
export function openSource(dbPath: string): Source {
  const db = new Database(dbPath, { readonly: true });

  const allLogs = db.query<EventRow, []>(
    `SELECT ${LOG_COLUMNS} FROM events ORDER BY timestamp, event_hash`,
  );
  const logsFrom = db.query<EventRow, { $ts: string }>(
    `SELECT ${LOG_COLUMNS} FROM events
       WHERE timestamp >= $ts
     ORDER BY timestamp, event_hash`,
  );

  const allCounts = db.query<CountsRow, []>(
    `${COUNTS_SELECT} ORDER BY c.last_event_at, c.session_id`,
  );
  const countsFrom = db.query<CountsRow, { $ts: string }>(
    `${COUNTS_SELECT} WHERE c.last_event_at >= $ts
     ORDER BY c.last_event_at, c.session_id`,
  );

  const allFileEdits = db.query<FileEditQueryRow, []>(
    `${FILE_EDITS_SELECT} ORDER BY fe.session_id, fe.file_path`,
  );
  const fileEditsFrom = db.query<FileEditQueryRow, { $ts: string }>(
    `${FILE_EDITS_SELECT} WHERE c.last_event_at >= $ts
     ORDER BY fe.session_id, fe.file_path`,
  );

  const allGateDenials = db.query<GateDenialQueryRow, []>(
    `${GATE_DENIALS_SELECT} ORDER BY gd.session_id, gd.denied_at`,
  );
  const gateDenialsFrom = db.query<GateDenialQueryRow, { $ts: string }>(
    `${GATE_DENIALS_SELECT} WHERE c.last_event_at >= $ts
     ORDER BY gd.session_id, gd.denied_at`,
  );

  // The three trace sub-streams each advance their own boundary cursor: point
  // events by event timestamp, tool spans by close time, session spans by
  // session close time. Each span is emitted exactly once.
  const allSessionSpans = db.query<SessionSpanQueryRow, []>(
    `${SESSION_SPANS_SELECT} ORDER BY c.session_ended_at, c.session_id`,
  );
  const sessionSpansFrom = db.query<SessionSpanQueryRow, { $ts: string }>(
    `${SESSION_SPANS_SELECT} AND c.session_ended_at >= $ts
     ORDER BY c.session_ended_at, c.session_id`,
  );

  const allToolSpans = db.query<ToolSpanQueryRow, []>(
    `${TOOL_SPANS_SELECT} ORDER BY t.ended_at, t.session_id, t.tool_call_id`,
  );
  const toolSpansFrom = db.query<ToolSpanQueryRow, { $ts: string }>(
    `${TOOL_SPANS_SELECT} AND t.ended_at >= $ts
     ORDER BY t.ended_at, t.session_id, t.tool_call_id`,
  );

  const allPointEvents = db.query<EventRow, []>(
    `${POINT_EVENTS_SELECT} ORDER BY timestamp, event_hash`,
  );
  const pointEventsFrom = db.query<EventRow, { $ts: string }>(
    `${POINT_EVENTS_SELECT} AND timestamp >= $ts
     ORDER BY timestamp, event_hash`,
  );

  return {
    pullLogs(watermark: string | null): LogsBatch {
      // A watermark the bridge itself wrote, but decode it defensively: an
      // unreadable one resets to a full re-read rather than stalling the
      // logs stream on every tick.
      let cursor: BoundaryCursor | null = null;
      if (watermark !== null) {
        try {
          cursor = JSON.parse(watermark) as BoundaryCursor;
        } catch {
          console.error(
            "bridge: unreadable logs watermark, re-reading from the start",
          );
        }
      }
      const queried = (
        cursor === null ? allLogs.all() : logsFrom.all({ $ts: cursor.ts })
      ).map(toLogRow);
      const { fresh, next } = advanceBoundary(
        queried,
        cursor,
        (row) => row.timestamp,
        (row) => row.eventHash,
      );
      if (fresh.length === 0) {
        return { rows: [], nextWatermark: watermark };
      }
      return { rows: fresh, nextWatermark: JSON.stringify(next) };
    },
    pullMetrics(watermark: string | null): MetricsBatch {
      const countsRows =
        watermark === null
          ? allCounts.all()
          : countsFrom.all({ $ts: watermark });
      if (countsRows.length === 0) {
        // No conversation active since the watermark: nothing on any signal.
        return {
          counts: [],
          fileEdits: [],
          gateDenials: [],
          nextWatermark: watermark,
        };
      }
      const fileEditRows =
        watermark === null
          ? allFileEdits.all()
          : fileEditsFrom.all({ $ts: watermark });
      const gateDenialRows =
        watermark === null
          ? allGateDenials.all()
          : gateDenialsFrom.all({ $ts: watermark });
      return {
        counts: countsRows.map(toCountsRow),
        fileEdits: fileEditRows.map(toFileEditRow),
        gateDenials: gateDenialRows.map(toGateDenialRow),
        nextWatermark: countsRows[countsRows.length - 1]!.last_event_at,
      };
    },
    pullTraces(watermark: string | null): TracesBatch {
      // The traces watermark holds three boundary cursors. Decode it
      // defensively: an unreadable one (or a pre-rebuild plain-timestamp
      // watermark) resets to a full re-emit rather than crashing.
      let cursor: TracesCursor = { point: null, tool: null, session: null };
      if (watermark !== null) {
        try {
          const parsed = JSON.parse(watermark) as Partial<TracesCursor>;
          cursor = {
            point: parsed.point ?? null,
            tool: parsed.tool ?? null,
            session: parsed.session ?? null,
          };
        } catch {
          console.error(
            "bridge: unreadable traces watermark, re-reading from the start",
          );
        }
      }

      const sessionRows = (
        cursor.session === null
          ? allSessionSpans.all()
          : sessionSpansFrom.all({ $ts: cursor.session.ts })
      ).map(toSessionSpanRow);
      const session = advanceBoundary(
        sessionRows,
        cursor.session,
        (row) => row.endedAt,
        (row) => row.sessionId,
      );

      const toolRows = (
        cursor.tool === null
          ? allToolSpans.all()
          : toolSpansFrom.all({ $ts: cursor.tool.ts })
      ).map(toToolSpanRow);
      const tool = advanceBoundary(
        toolRows,
        cursor.tool,
        (row) => row.endedAt,
        (row) => JSON.stringify([row.sessionId, row.toolCallId]),
      );

      const pointRows = (
        cursor.point === null
          ? allPointEvents.all()
          : pointEventsFrom.all({ $ts: cursor.point.ts })
      ).map(toLogRow);
      const point = advanceBoundary(
        pointRows,
        cursor.point,
        (row) => row.timestamp,
        (row) => row.eventHash,
      );

      return {
        sessionSpans: session.fresh,
        toolSpans: tool.fresh,
        pointEvents: point.fresh,
        nextWatermark: JSON.stringify({
          point: point.next,
          tool: tool.next,
          session: session.next,
        }),
      };
    },
    close(): void {
      db.close();
    },
  };
}
