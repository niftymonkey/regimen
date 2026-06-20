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
