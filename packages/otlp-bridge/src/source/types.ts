/**
 * The typed batches the Source hands to the Projection.
 *
 * These mirror the feedback package's store rows, normalized: the `attributes`
 * JSON column is parsed, BLOB ids are hex, and nullable columns are typed
 * optionals. Everything downstream of the Source works with these types and
 * never touches SQLite.
 */

/** One `events` row, normalized. Drives a log record and a metric counter tick. */
export interface LogRow {
  /** The event's `event_hash` primary key, hex-encoded. */
  eventHash: string;
  schemaVersion: number;
  traceId: string;
  sessionId: string;
  timestamp: string;
  harness: string;
  /** The model that ran the turn; null when the harness did not resolve one. */
  model: string | null;
  eventType: string;
  spanPhase: string;
  spanName: string;
  attributes: Record<string, string>;
}

/** A batch of new `events` rows plus the cursor to resume from. */
export interface LogsBatch {
  rows: LogRow[];
  /** The cursor to pass to the next `pullLogs`; unchanged when nothing was read. */
  nextWatermark: string | null;
}

/**
 * Per-session counts from the `conversation_counts` view, joined to the
 * conversation's harness and model. Each count is a measured cumulative sum
 * over the session's events; a genuine zero (a measured session that had no
 * compactions) is a real value, not a fabricated default.
 */
export interface ConversationCountsRow {
  sessionId: string;
  harness: string;
  model: string | null;
  promptCount: number;
  toolCallCount: number;
  compactionCount: number;
  /** The conversation's most recent event time; the metric data point's time. */
  lastEventAt: string;
}

/** One `repeated_file_edits` row: churn on a single file within a session. */
export interface FileEditRow {
  sessionId: string;
  harness: string;
  filePath: string;
  editCount: number;
  lastEditedAt: string;
}

/**
 * A batch for the metrics stream. Counts re-emit for every conversation active
 * since the watermark; file edits surface only as rows that exist, never as
 * fabricated zeros.
 */
export interface MetricsBatch {
  counts: ConversationCountsRow[];
  fileEdits: FileEditRow[];
  /** Highest conversation `last_event_at` observed; unchanged when none. */
  nextWatermark: string | null;
}

/**
 * A closed conversation, the source of a session span. Only conversations
 * with a real `session_ended_at` reach here; an open conversation is never
 * force-closed into a span. `startedAt` can still be null (capture began
 * mid-session); the Projection decides what a null start means for the span.
 */
export interface SessionSpanRow {
  sessionId: string;
  traceId: string;
  harness: string;
  model: string | null;
  startedAt: string | null;
  endedAt: string;
}

/**
 * A closed tool call, the source of a tool span. Only `tool_call_spans` rows
 * with a real `ended_at` reach here; an unpaired (open) tool call is skipped.
 */
export interface ToolSpanRow {
  sessionId: string;
  traceId: string;
  harness: string;
  toolName: string;
  toolCallId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
}

/**
 * A batch for the traces stream. Session spans cover only closed
 * conversations; tool spans cover only closed tool calls; point events
 * (`user_prompt`, `compaction`) are emitted as they arrive, whether or not
 * their session has closed.
 */
export interface TracesBatch {
  sessionSpans: SessionSpanRow[];
  toolSpans: ToolSpanRow[];
  pointEvents: LogRow[];
  /** Highest conversation `last_event_at` observed; unchanged when none. */
  nextWatermark: string | null;
}
