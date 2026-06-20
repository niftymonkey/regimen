import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegimenEvent } from "../hooks/event-log.ts";
import { openStore } from "../src/store.ts";

const baseEvent: RegimenEvent = {
  schema_version: 1,
  timestamp: "2026-05-21T12:00:00.000Z",
  session_id: "session-abc",
  harness: "claude",
  model: "claude-opus-4-7",
  event_type: "tool.pre",
  trace_id: "0123456789abcdef0123456789abcdef",
  span_phase: "start",
  span_name: "tool:Edit",
  attributes: { tool_name: "Edit", tool_call_id: "toolu_x" },
};

/** A temp directory that the test owns and cleans up after `fn`. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-store-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("openStore creates the events, quarantine, and schema_migrations tables", () => {
  withTempDir((dir) => {
    const store = openStore(join(dir, "feedback.db"));
    try {
      const tables = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as ReadonlyArray<{ name: string }>;
      const names = new Set(tables.map((row) => row.name));
      expect(names.has("events")).toBe(true);
      expect(names.has("quarantine")).toBe(true);
      expect(names.has("schema_migrations")).toBe(true);
    } finally {
      store.close();
    }
  });
});

test("insertEvent persists every column required by the events schema", () => {
  withTempDir((dir) => {
    const store = openStore(join(dir, "feedback.db"));
    try {
      const result = store.insertEvent(baseEvent);
      expect(result.inserted).toBe(true);
      const row = store.db
        .prepare(
          "SELECT schema_version, trace_id, session_id, timestamp, harness, model, event_type, span_phase, span_name, attributes FROM events",
        )
        .get() as Record<string, unknown>;
      expect(row.schema_version).toBe(1);
      expect(row.trace_id).toBe(baseEvent.trace_id);
      expect(row.session_id).toBe(baseEvent.session_id);
      expect(row.timestamp).toBe(baseEvent.timestamp);
      expect(row.harness).toBe(baseEvent.harness);
      expect(row.model).toBe(baseEvent.model);
      expect(row.event_type).toBe(baseEvent.event_type);
      expect(row.span_phase).toBe(baseEvent.span_phase);
      expect(row.span_name).toBe(baseEvent.span_name);
      expect(JSON.parse(row.attributes as string)).toEqual(
        baseEvent.attributes,
      );
    } finally {
      store.close();
    }
  });
});

test("model is stored as NULL when the event omits it", () => {
  withTempDir((dir) => {
    const store = openStore(join(dir, "feedback.db"));
    try {
      const noModel: RegimenEvent = { ...baseEvent };
      delete (noModel as Partial<RegimenEvent>).model;
      store.insertEvent(noModel);
      const row = store.db.prepare("SELECT model FROM events").get() as {
        model: string | null;
      };
      expect(row.model).toBeNull();
    } finally {
      store.close();
    }
  });
});

test("re-inserting an identical event is a no-op via INSERT OR IGNORE", () => {
  withTempDir((dir) => {
    const store = openStore(join(dir, "feedback.db"));
    try {
      expect(store.insertEvent(baseEvent).inserted).toBe(true);
      expect(store.insertEvent(baseEvent).inserted).toBe(false);
      const count = (
        store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
          n: number;
        }
      ).n;
      expect(count).toBe(1);
    } finally {
      store.close();
    }
  });
});

test("two structurally-different events both land", () => {
  withTempDir((dir) => {
    const store = openStore(join(dir, "feedback.db"));
    try {
      store.insertEvent(baseEvent);
      const post: RegimenEvent = {
        ...baseEvent,
        event_type: "tool.post",
        span_phase: "end",
        timestamp: "2026-05-21T12:00:01.000Z",
      };
      expect(store.insertEvent(post).inserted).toBe(true);
      const count = (
        store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
          n: number;
        }
      ).n;
      expect(count).toBe(2);
    } finally {
      store.close();
    }
  });
});

test("reopening an existing store preserves data and skips already-applied migrations", () => {
  withTempDir((dir) => {
    const path = join(dir, "feedback.db");
    const first = openStore(path);
    first.insertEvent(baseEvent);
    const initialMigrations = (
      first.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
        n: number;
      }
    ).n;
    expect(initialMigrations).toBeGreaterThan(0);
    first.close();

    const second = openStore(path);
    try {
      const count = (
        second.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
          n: number;
        }
      ).n;
      expect(count).toBe(1);
      const migrations = (
        second.db
          .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
          .get() as { n: number }
      ).n;
      expect(migrations).toBe(initialMigrations);
    } finally {
      second.close();
    }
  });
});

test("the end-reason migration is additive: a pre-change store and its session.end rows load with NULL reasons", () => {
  withTempDir((dir) => {
    const path = join(dir, "feedback.db");

    // A store as it stood before the end-reason columns existed: the
    // conversations table without them, a session.end row already written,
    // and schema_migrations marking only versions 1 to 3 as applied.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, description, applied_at) VALUES
        (1, 'events and quarantine tables', '2026-01-01T00:00:00.000Z'),
        (2, 'deterministic signal tables and single-event count view', '2026-01-01T00:00:00.000Z'),
        (3, 'skill-invocation signal table', '2026-01-01T00:00:00.000Z');
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
      CREATE TABLE quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        raw_line TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE conversations (
        session_id TEXT PRIMARY KEY NOT NULL,
        harness TEXT NOT NULL,
        model TEXT,
        session_started_at TEXT,
        session_ended_at TEXT,
        first_event_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO conversations
        (session_id, harness, model, session_started_at, session_ended_at, first_event_at, last_event_at)
      VALUES
        ('legacy-session', 'claude', 'claude-opus-4-7', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z');
    `);
    old.close();

    const store = openStore(path);
    try {
      const row = store.db
        .prepare(
          "SELECT session_id, session_ended_at, session_end_reason_native, session_end_reason_normalized FROM conversations WHERE session_id = ?",
        )
        .get("legacy-session") as Record<string, unknown> | undefined;

      expect(row?.session_id).toBe("legacy-session");
      expect(row?.session_ended_at).toBe("2026-01-01T00:30:00.000Z");
      expect(row?.session_end_reason_native).toBeNull();
      expect(row?.session_end_reason_normalized).toBeNull();
    } finally {
      store.close();
    }
  });
});

test("quarantine records a bad line with its reason and a timestamp", () => {
  withTempDir((dir) => {
    const store = openStore(join(dir, "feedback.db"));
    try {
      store.quarantine("not-json{", "JSON parse failure");
      const row = store.db
        .prepare("SELECT raw_line, reason FROM quarantine")
        .get() as { raw_line: string; reason: string };
      expect(row.raw_line).toBe("not-json{");
      expect(row.reason).toBe("JSON parse failure");
    } finally {
      store.close();
    }
  });
});
