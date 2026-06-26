/**
 * The Feedback SQLite store: open, migrate, and the writer-side primitives
 * the loader uses on every event.
 *
 * The store is the Feedback instrument's durable substrate per ADR-0005:
 * one file, one events table the loader writes to with INSERT OR IGNORE
 * keyed on the sha256 event_hash from src/hash.ts, plus a quarantine table
 * for lines that fail to translate. Migration v2 adds the deterministic
 * signal tables ADR-0006 names (conversations, tool_call_spans,
 * repeated_file_edits) and the conversation_counts SQL view
 * for single-event aggregations; migration v3 adds the skill_invocations
 * table that retains which skill each Skill tool call ran. insertEvent runs
 * projectSignals inside the same transaction so a row in events is committed
 * only alongside the signal rows it implies. The judgment layer will add its
 * own tables under a later migration.
 */
import { Database } from "bun:sqlite";
import type { RegimenEvent } from "../hooks/event-log.ts";
import { eventHash } from "./hash.ts";
import { projectSignals } from "./loader/projections.ts";

/**
 * The schema migrations. Ordered by `version`, applied once each in order.
 * `schema_migrations` records the applied set so reopening an existing store
 * is a no-op past whichever migrations have already run.
 */
interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: string;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "events and quarantine tables",
    up: `
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
    `,
  },
  {
    version: 2,
    description: "deterministic signal tables and single-event count view",
    up: `
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
    `,
  },
  {
    version: 3,
    description: "skill-invocation signal table",
    up: `
      CREATE TABLE skill_invocations (
        session_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        invocation_count INTEGER NOT NULL,
        last_invoked_at TEXT NOT NULL,
        PRIMARY KEY (session_id, skill_name)
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 4,
    description: "session-end reason columns on conversations",
    up: `
      ALTER TABLE conversations ADD COLUMN session_end_reason_native TEXT;
      ALTER TABLE conversations ADD COLUMN session_end_reason_normalized TEXT;
    `,
  },
  {
    version: 5,
    description: "working-directory column on conversations",
    up: `
      ALTER TABLE conversations ADD COLUMN cwd TEXT;
    `,
  },
  {
    version: 6,
    description: "judged-layer tables (ADR-0008)",
    up: `
      CREATE TABLE assessment_run (
        run_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        rubric_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        judge_model TEXT NOT NULL,
        complete INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX assessment_run_session_created ON assessment_run (session_id, created_at);

      CREATE TABLE assignment (
        session_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        PRIMARY KEY (session_id, assignment_id)
      ) WITHOUT ROWID;

      CREATE TABLE judged_signal (
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        assignment_id TEXT NOT NULL DEFAULT '',
        signal_name TEXT NOT NULL,
        value_kind TEXT NOT NULL,
        value TEXT NOT NULL,
        anchors TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (session_id, scope, assignment_id, signal_name)
      ) WITHOUT ROWID;

      CREATE TABLE narrative (
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        assignment_id TEXT NOT NULL DEFAULT '',
        narrative_type TEXT NOT NULL,
        prose TEXT NOT NULL,
        anchors TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (session_id, scope, assignment_id, narrative_type)
      ) WITHOUT ROWID;
    `,
  },
];

/** Result of an event insert. `inserted: false` means an identical hash already existed. */
export interface InsertResult {
  readonly inserted: boolean;
}

/**
 * The opened store. Holds the database handle and a few cached prepared
 * statements the loader calls on every event. `close` releases the handle.
 */
export interface Store {
  readonly db: Database;
  insertEvent(event: RegimenEvent): InsertResult;
  quarantine(rawLine: string, reason: string): void;
  close(): void;
}

/**
 * Open the store at `path` (or in memory if `:memory:`), run any pending
 * migrations, and return a writer-side handle the loader uses to insert
 * events and quarantine bad lines.
 *
 * WAL is enabled so a concurrent reader (the future Feedback CLI, the OTLP
 * bridge) can read while the loader writes, and synchronous=NORMAL is the
 * safe WAL companion that trades a power-loss-window for write throughput.
 */
export function openStore(path: string): Store {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO events
       (event_hash, schema_version, trace_id, session_id, timestamp,
        harness, model, event_type, span_phase, span_name, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const quarantineStmt = db.prepare(
    `INSERT INTO quarantine (recorded_at, raw_line, reason) VALUES (?, ?, ?)`,
  );

  const insertWithProjections = db.transaction(
    (event: RegimenEvent): boolean => {
      const hash = eventHash(event);
      const info = insertStmt.run(
        hash,
        event.schema_version,
        event.trace_id,
        event.session_id,
        event.timestamp,
        event.harness,
        event.model ?? null,
        event.event_type,
        event.span_phase,
        event.span_name,
        JSON.stringify(event.attributes),
      );
      if (info.changes !== 1) return false;
      projectSignals(db, event);
      return true;
    },
  );

  return {
    db,
    insertEvent(event: RegimenEvent): InsertResult {
      return { inserted: insertWithProjections(event) };
    },
    quarantine(rawLine: string, reason: string): void {
      quarantineStmt.run(new Date().toISOString(), rawLine, reason);
    },
    close(): void {
      db.close();
    },
  };
}

/**
 * Apply every migration whose version is not already in `schema_migrations`,
 * each in its own transaction so a half-applied schema cannot stick.
 */
function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const alreadyApplied = db.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  );
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    if (alreadyApplied.get(migration.version) !== null) continue;
    db.transaction(() => {
      db.exec(migration.up);
      record.run(
        migration.version,
        migration.description,
        new Date().toISOString(),
      );
    })();
  }
}
