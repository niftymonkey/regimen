import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSource } from "../../src/source/source.ts";
import {
  createFeedbackDb,
  insertConversation,
  insertEvent,
  insertFileEdit,
} from "../fixtures/feedback-db.ts";

function tempDbPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "regimen-bridge-met-")),
    "feedback.db",
  );
}

test("a conversation yields one counts row with its measured counters", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    harness: "claude",
    model: "claude-opus-4-7",
    last_event_at: "2026-05-21T12:00:03.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    event_type: "user_prompt",
    timestamp: "2026-05-21T12:00:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    event_type: "user_prompt",
    timestamp: "2026-05-21T12:00:01.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    event_type: "tool.pre",
    timestamp: "2026-05-21T12:00:02.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    event_type: "compaction",
    timestamp: "2026-05-21T12:00:03.000Z",
  });

  const source = openSource(path);
  const batch = source.pullMetrics(null);
  source.close();
  db.close();

  expect(batch.counts).toHaveLength(1);
  expect(batch.counts[0]).toEqual({
    sessionId: "sess-a",
    harness: "claude",
    model: "claude-opus-4-7",
    promptCount: 2,
    toolCallCount: 1,
    compactionCount: 1,
    lastEventAt: "2026-05-21T12:00:03.000Z",
  });
});

test("a repeated-file-edit row surfaces with its conversation's harness", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    harness: "claude",
    last_event_at: "2026-05-21T12:00:05.000Z",
  });
  insertEvent(db, { session_id: "sess-a", event_type: "tool.post" });
  insertFileEdit(db, {
    session_id: "sess-a",
    file_path: "src/source/source.ts",
    edit_count: 4,
    last_edited_at: "2026-05-21T12:00:05.000Z",
  });

  const source = openSource(path);
  const batch = source.pullMetrics(null);
  source.close();
  db.close();

  expect(batch.fileEdits).toHaveLength(1);
  expect(batch.fileEdits[0]).toEqual({
    sessionId: "sess-a",
    harness: "claude",
    filePath: "src/source/source.ts",
    editCount: 4,
    lastEditedAt: "2026-05-21T12:00:05.000Z",
  });
});

test("a session with no file edits surfaces no zero rows", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:00:01.000Z",
  });
  insertEvent(db, { session_id: "sess-a", event_type: "user_prompt" });

  const source = openSource(path);
  const batch = source.pullMetrics(null);
  source.close();
  db.close();

  expect(batch.counts).toHaveLength(1);
  expect(batch.fileEdits).toHaveLength(0);
});

test("a second pull drops conversations below the watermark and picks up newer ones", () => {
  // Metrics are cumulative, so the boundary conversation is re-read on overlap;
  // conversations strictly below the watermark are not.
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-old",
    last_event_at: "2026-05-21T12:00:01.000Z",
  });
  insertEvent(db, { session_id: "sess-old", event_type: "user_prompt" });
  insertConversation(db, {
    session_id: "sess-recent",
    last_event_at: "2026-05-21T12:00:05.000Z",
  });
  insertEvent(db, {
    session_id: "sess-recent",
    event_type: "user_prompt",
    timestamp: "2026-05-21T12:00:05.000Z",
  });

  const source = openSource(path);
  const first = source.pullMetrics(null);
  expect(first.counts.map((c) => c.sessionId).sort()).toEqual([
    "sess-old",
    "sess-recent",
  ]);
  expect(first.nextWatermark).toBe("2026-05-21T12:00:05.000Z");

  // Second pull: sess-old is below the watermark and drops; sess-recent sits
  // on the boundary and is re-read.
  const second = source.pullMetrics(first.nextWatermark);
  expect(second.counts.map((c) => c.sessionId)).toEqual(["sess-recent"]);

  // A newer conversation appears and is picked up.
  insertConversation(db, {
    session_id: "sess-new",
    last_event_at: "2026-05-21T13:00:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-new",
    event_type: "user_prompt",
    timestamp: "2026-05-21T13:00:00.000Z",
  });
  const third = source.pullMetrics(second.nextWatermark);
  source.close();
  db.close();

  expect(third.counts.map((c) => c.sessionId)).toContain("sess-new");
});
