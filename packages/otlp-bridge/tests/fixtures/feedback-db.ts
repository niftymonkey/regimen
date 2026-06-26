/**
 * Test fixture: a SQLite database matching the regimen-feedback store contract.
 *
 * The bridge reads the Feedback store described by ADR-0005 and ADR-0006. It
 * depends on the *schema contract*, never on regimen-feedback's code, so this
 * fixture mirrors that contract (the v1 and v2 loader migrations) for tests.
 * If a Source test fails after a regimen-feedback schema change, this fixture
 * is where the contract drift surfaces.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** The events and signal tables the loader materializes (migrations v1 + v2). */
const SCHEMA_SQL = `
  CREATE TABLE events (
    event_hash BLOB PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL,
    trace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    harness TEXT NOT NULL,
    model TEXT,
    event_type TEXT NOT NULL,
    span_phase TEXT NOT NULL,
    span_name TEXT NOT NULL,
    attributes TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX events_trace_ts ON events (trace_id, timestamp);
  CREATE INDEX events_session_ts ON events (session_id, timestamp);
  CREATE INDEX events_type_ts ON events (event_type, timestamp);

  CREATE TABLE quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    raw_line TEXT NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE INDEX quarantine_recorded_at ON quarantine (recorded_at);

  CREATE TABLE conversations (
    session_id TEXT PRIMARY KEY NOT NULL,
    harness TEXT NOT NULL,
    model TEXT,
    session_started_at TEXT,
    session_ended_at TEXT,
    first_event_at TEXT NOT NULL,
    last_event_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX conversations_last_event_at ON conversations (last_event_at);

  CREATE TABLE tool_call_spans (
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    PRIMARY KEY (session_id, tool_call_id)
  ) WITHOUT ROWID;
  CREATE INDEX tool_call_spans_session_started ON tool_call_spans (session_id, started_at);

  CREATE TABLE repeated_file_edits (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    edit_count INTEGER NOT NULL,
    last_edited_at TEXT NOT NULL,
    PRIMARY KEY (session_id, file_path)
  ) WITHOUT ROWID;

  CREATE VIEW conversation_counts AS
  SELECT
    session_id,
    SUM(CASE WHEN event_type = 'user_prompt'  THEN 1 ELSE 0 END) AS prompt_count,
    SUM(CASE WHEN event_type = 'tool.pre'     THEN 1 ELSE 0 END) AS tool_call_count,
    SUM(CASE WHEN event_type = 'compaction'   THEN 1 ELSE 0 END) AS compaction_count,
    COUNT(*) AS event_count
  FROM events
  GROUP BY session_id;
`;

/** Create a Feedback store at `path` with the loader's schema, WAL mode on. */
export function createFeedbackDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  return db;
}

/** A row to seed into `events`; unset fields take a user_prompt default. */
export interface EventSeed {
  schema_version?: number;
  trace_id?: string;
  session_id?: string;
  timestamp?: string;
  harness?: string;
  model?: string | null;
  event_type?: string;
  span_phase?: string;
  span_name?: string;
  attributes?: Record<string, string>;
  /** An explicit hex event_hash, to control cursor-tiebreaker ordering. */
  event_hash?: string;
}

/** Insert one event row, deriving a unique event_hash from its content. */
export function insertEvent(db: Database, seed: EventSeed = {}): void {
  const event = {
    schema_version: 1,
    trace_id: "0123456789abcdef0123456789abcdef",
    session_id: "sess-1",
    timestamp: "2026-05-21T12:00:00.000Z",
    harness: "claude",
    model: null as string | null,
    event_type: "user_prompt",
    span_phase: "point",
    span_name: "user_prompt",
    attributes: {} as Record<string, string>,
    ...seed,
  };
  const eventHash =
    seed.event_hash !== undefined
      ? Buffer.from(seed.event_hash, "hex")
      : createHash("sha256").update(JSON.stringify(event)).digest();
  db.prepare(
    `INSERT INTO events
       (event_hash, schema_version, trace_id, session_id, timestamp,
        harness, model, event_type, span_phase, span_name, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventHash,
    event.schema_version,
    event.trace_id,
    event.session_id,
    event.timestamp,
    event.harness,
    event.model,
    event.event_type,
    event.span_phase,
    event.span_name,
    JSON.stringify(event.attributes),
  );
}

/** A row to seed into `conversations`; unset fields take an open-session default. */
export interface ConversationSeed {
  session_id?: string;
  harness?: string;
  model?: string | null;
  session_started_at?: string | null;
  session_ended_at?: string | null;
  first_event_at?: string;
  last_event_at?: string;
}

/** Insert one conversation rollup row. */
export function insertConversation(
  db: Database,
  seed: ConversationSeed = {},
): void {
  const row = {
    session_id: "sess-1",
    harness: "claude",
    model: null as string | null,
    session_started_at: "2026-05-21T12:00:00.000Z" as string | null,
    session_ended_at: null as string | null,
    first_event_at: "2026-05-21T12:00:00.000Z",
    last_event_at: "2026-05-21T12:00:00.000Z",
    ...seed,
  };
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, session_started_at, session_ended_at,
        first_event_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session_id,
    row.harness,
    row.model,
    row.session_started_at,
    row.session_ended_at,
    row.first_event_at,
    row.last_event_at,
  );
}

/** A row to seed into `tool_call_spans`; unset fields take an open-call default. */
export interface ToolCallSpanSeed {
  session_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  started_at?: string;
  ended_at?: string | null;
  duration_ms?: number | null;
}

/** Insert one tool-call-span row. */
export function insertToolCallSpan(
  db: Database,
  seed: ToolCallSpanSeed = {},
): void {
  const row = {
    session_id: "sess-1",
    tool_call_id: "tc-1",
    tool_name: "Bash",
    started_at: "2026-05-21T12:00:00.000Z",
    ended_at: null as string | null,
    duration_ms: null as number | null,
    ...seed,
  };
  db.prepare(
    `INSERT INTO tool_call_spans
       (session_id, tool_call_id, tool_name, started_at, ended_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session_id,
    row.tool_call_id,
    row.tool_name,
    row.started_at,
    row.ended_at,
    row.duration_ms,
  );
}

/** A row to seed into `repeated_file_edits`. */
export interface FileEditSeed {
  session_id?: string;
  file_path?: string;
  edit_count?: number;
  last_edited_at?: string;
}

/** Insert one repeated-file-edits row. */
export function insertFileEdit(db: Database, seed: FileEditSeed = {}): void {
  const row = {
    session_id: "sess-1",
    file_path: "src/file.ts",
    edit_count: 1,
    last_edited_at: "2026-05-21T12:00:00.000Z",
    ...seed,
  };
  db.prepare(
    `INSERT INTO repeated_file_edits
       (session_id, file_path, edit_count, last_edited_at)
     VALUES (?, ?, ?, ?)`,
  ).run(row.session_id, row.file_path, row.edit_count, row.last_edited_at);
}
