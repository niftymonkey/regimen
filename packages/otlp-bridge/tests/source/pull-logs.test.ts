import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSource } from "../../src/source/source.ts";
import { createFeedbackDb, insertEvent } from "../fixtures/feedback-db.ts";

/** A fresh temp path for a feedback.db that does not yet exist. */
function tempDbPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "regimen-bridge-src-")),
    "feedback.db",
  );
}

test("one event row is pulled as one typed log row", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertEvent(db, {
    session_id: "sess-a",
    timestamp: "2026-05-21T12:00:00.000Z",
    event_type: "user_prompt",
    span_name: "user_prompt",
  });

  const source = openSource(path);
  const batch = source.pullLogs(null);
  source.close();
  db.close();

  expect(batch.rows).toHaveLength(1);
  expect(batch.rows[0]!.sessionId).toBe("sess-a");
  expect(batch.rows[0]!.eventType).toBe("user_prompt");
  expect(batch.rows[0]!.timestamp).toBe("2026-05-21T12:00:00.000Z");
});

test("a second pull from the returned watermark reads only newer events", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertEvent(db, {
    timestamp: "2026-05-21T12:00:00.000Z",
    event_type: "session.start",
  });
  insertEvent(db, {
    timestamp: "2026-05-21T12:00:01.000Z",
    event_type: "user_prompt",
  });

  const source = openSource(path);
  const first = source.pullLogs(null);
  expect(first.rows).toHaveLength(2);

  // Nothing new since: empty batch, watermark unchanged.
  const second = source.pullLogs(first.nextWatermark);
  expect(second.rows).toHaveLength(0);
  expect(second.nextWatermark).toBe(first.nextWatermark);

  // A newer event lands; only it comes back.
  insertEvent(db, {
    timestamp: "2026-05-21T12:00:02.000Z",
    event_type: "session.end",
  });
  const third = source.pullLogs(second.nextWatermark);
  expect(third.rows).toHaveLength(1);
  expect(third.rows[0]!.eventType).toBe("session.end");

  source.close();
  db.close();
});

test("an event inserted at an already-emitted millisecond is still pulled, whatever its hash", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertEvent(db, {
    timestamp: "2026-05-21T12:00:00.000Z",
    event_hash: "f".repeat(64),
    event_type: "user_prompt",
  });

  const source = openSource(path);
  const first = source.pullLogs(null);
  expect(first.rows).toHaveLength(1);

  // A second event lands at the same millisecond; its hash sorts BEFORE the
  // first. A timestamp-and-hash cursor would skip it forever.
  insertEvent(db, {
    timestamp: "2026-05-21T12:00:00.000Z",
    event_hash: "0".repeat(64),
    event_type: "session.end",
  });
  const second = source.pullLogs(first.nextWatermark);

  expect(second.rows).toHaveLength(1);
  expect(second.rows[0]!.eventType).toBe("session.end");

  source.close();
  db.close();
});

test("an empty store yields an empty batch and an unchanged watermark", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);

  const source = openSource(path);
  const batch = source.pullLogs(null);
  source.close();
  db.close();

  expect(batch.rows).toHaveLength(0);
  expect(batch.nextWatermark).toBeNull();
});

test("the event attributes column is parsed into an object", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertEvent(db, {
    event_type: "tool.pre",
    span_phase: "start",
    span_name: "tool:Bash",
    attributes: { tool_name: "Bash", tool_call_id: "tc-1" },
  });

  const source = openSource(path);
  const batch = source.pullLogs(null);
  source.close();
  db.close();

  expect(batch.rows[0]!.attributes).toEqual({
    tool_name: "Bash",
    tool_call_id: "tc-1",
  });
});

test("a null model column is preserved as null, a present one as its value", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertEvent(db, { timestamp: "2026-05-21T12:00:00.000Z", model: null });
  insertEvent(db, {
    timestamp: "2026-05-21T12:00:01.000Z",
    model: "claude-opus-4-7",
  });

  const source = openSource(path);
  const batch = source.pullLogs(null);
  source.close();
  db.close();

  expect(batch.rows[0]!.model).toBeNull();
  expect(batch.rows[1]!.model).toBe("claude-opus-4-7");
});

test("a backlog larger than the row cap drains in order over successive pulls", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  for (const second of ["01", "02", "03", "04", "05"]) {
    insertEvent(db, {
      timestamp: `2026-05-21T12:00:${second}.000Z`,
      span_name: `event-${second}`,
    });
  }

  const source = openSource(path, { maxRows: 2 });
  const first = source.pullLogs(null);
  const second = source.pullLogs(first.nextWatermark);
  const third = source.pullLogs(second.nextWatermark);
  const fourth = source.pullLogs(third.nextWatermark);
  source.close();
  db.close();

  expect(first.rows.map((r) => r.spanName)).toEqual(["event-01", "event-02"]);
  expect(second.rows.map((r) => r.spanName)).toEqual(["event-03", "event-04"]);
  expect(third.rows.map((r) => r.spanName)).toEqual(["event-05"]);
  expect(fourth.rows).toHaveLength(0);
});

test("a capped pull at a crowded millisecond never re-emits a row or exceeds the cap", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  const ts = "2026-05-21T12:00:00.000Z";
  insertEvent(db, {
    timestamp: ts,
    event_hash: "f".repeat(64),
    span_name: "first",
  });

  const source = openSource(path, { maxRows: 2 });
  const first = source.pullLogs(null);
  expect(first.rows.map((r) => r.spanName)).toEqual(["first"]);

  // Three more events land at the same millisecond, all sorting BEFORE the
  // one already emitted, so the cap cuts the emitted row out of the re-read.
  for (const digit of ["0", "1", "2"]) {
    insertEvent(db, {
      timestamp: ts,
      event_hash: digit.repeat(64),
      span_name: `late-${digit}`,
    });
  }
  const second = source.pullLogs(first.nextWatermark);
  const third = source.pullLogs(second.nextWatermark);
  const fourth = source.pullLogs(third.nextWatermark);
  source.close();
  db.close();

  expect(second.rows.map((r) => r.spanName)).toEqual(["late-0", "late-1"]);
  expect(third.rows.map((r) => r.spanName)).toEqual(["late-2"]);
  expect(fourth.rows).toHaveLength(0);
});

test("with no cap configured, one pull returns at most 1000 rows", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  db.transaction(() => {
    for (let i = 0; i < 1001; i += 1) {
      insertEvent(db, {
        timestamp: new Date(Date.UTC(2026, 4, 21, 12, 0, i)).toISOString(),
      });
    }
  })();

  const source = openSource(path);
  const first = source.pullLogs(null);
  const second = source.pullLogs(first.nextWatermark);
  source.close();
  db.close();

  expect(first.rows).toHaveLength(1000);
  expect(second.rows).toHaveLength(1);
});
