import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSource } from "../../src/source/source.ts";
import {
  createFeedbackDb,
  insertConversation,
  insertEvent,
  insertToolCallSpan,
} from "../fixtures/feedback-db.ts";

function tempDbPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "regimen-bridge-trc-")),
    "feedback.db",
  );
}

const TRACE_ID = "0123456789abcdef0123456789abcdef";

test("a closed conversation yields one session-span source row", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    harness: "claude",
    model: "claude-opus-4-7",
    session_started_at: "2026-05-21T12:00:00.000Z",
    session_ended_at: "2026-05-21T12:30:00.000Z",
    last_event_at: "2026-05-21T12:30:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "session.start",
  });

  const source = openSource(path);
  const batch = source.pullTraces(null);
  source.close();
  db.close();

  expect(batch.sessionSpans).toHaveLength(1);
  expect(batch.sessionSpans[0]).toEqual({
    sessionId: "sess-a",
    traceId: TRACE_ID,
    harness: "claude",
    model: "claude-opus-4-7",
    startedAt: "2026-05-21T12:00:00.000Z",
    endedAt: "2026-05-21T12:30:00.000Z",
  });
});

test("an open conversation yields no session span", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-open",
    session_started_at: "2026-05-21T12:00:00.000Z",
    session_ended_at: null,
    last_event_at: "2026-05-21T12:10:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-open",
    trace_id: TRACE_ID,
    event_type: "user_prompt",
  });

  const source = openSource(path);
  const batch = source.pullTraces(null);
  source.close();
  db.close();

  // No session span (the conversation is open), but its point event still
  // surfaces: an unfinished session is a rootless trace, not an absent one.
  expect(batch.sessionSpans).toHaveLength(0);
  expect(batch.pointEvents).toHaveLength(1);
});

test("a closed tool call yields one tool-span source row", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    harness: "claude",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, { session_id: "sess-a", trace_id: TRACE_ID });
  insertToolCallSpan(db, {
    session_id: "sess-a",
    tool_call_id: "tc-7",
    tool_name: "Edit",
    started_at: "2026-05-21T12:01:00.000Z",
    ended_at: "2026-05-21T12:01:02.000Z",
    duration_ms: 2000,
  });

  const source = openSource(path);
  const batch = source.pullTraces(null);
  source.close();
  db.close();

  expect(batch.toolSpans).toHaveLength(1);
  expect(batch.toolSpans[0]).toEqual({
    sessionId: "sess-a",
    traceId: TRACE_ID,
    harness: "claude",
    toolName: "Edit",
    toolCallId: "tc-7",
    startedAt: "2026-05-21T12:01:00.000Z",
    endedAt: "2026-05-21T12:01:02.000Z",
    durationMs: 2000,
    deniedByGateId: null,
  });
});

test("an open tool call yields no tool span", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, { session_id: "sess-a", trace_id: TRACE_ID });
  insertToolCallSpan(db, {
    session_id: "sess-a",
    tool_call_id: "tc-open",
    started_at: "2026-05-21T12:01:00.000Z",
    ended_at: null,
  });

  const source = openSource(path);
  const batch = source.pullTraces(null);
  source.close();
  db.close();

  expect(batch.toolSpans).toHaveLength(0);
});

test("point events surface as rows carrying their session id, paired events do not", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "session.start",
    span_phase: "start",
    span_name: "session",
    timestamp: "2026-05-21T12:00:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "user_prompt",
    span_name: "user_prompt",
    timestamp: "2026-05-21T12:01:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "compaction",
    span_name: "compaction",
    timestamp: "2026-05-21T12:02:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "tool.pre",
    span_phase: "start",
    span_name: "tool:Bash",
    timestamp: "2026-05-21T12:03:00.000Z",
    attributes: { tool_name: "Bash", tool_call_id: "tc-1" },
  });

  const source = openSource(path);
  const batch = source.pullTraces(null);
  source.close();
  db.close();

  expect(batch.pointEvents.map((e) => e.eventType)).toEqual([
    "user_prompt",
    "compaction",
  ]);
  expect(batch.pointEvents.every((e) => e.sessionId === "sess-a")).toBe(true);
});

test("a closed tool span is emitted once, not again on the next pull", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, { session_id: "sess-a", trace_id: TRACE_ID });
  insertToolCallSpan(db, {
    session_id: "sess-a",
    tool_call_id: "tc-1",
    tool_name: "Bash",
    started_at: "2026-05-21T12:01:00.000Z",
    ended_at: "2026-05-21T12:01:02.000Z",
  });

  const source = openSource(path);
  const first = source.pullTraces(null);
  expect(first.toolSpans).toHaveLength(1);

  // A second pull from the returned watermark must not re-emit the tool span.
  const second = source.pullTraces(first.nextWatermark);
  source.close();
  db.close();

  expect(second.toolSpans).toHaveLength(0);
});

test("a closed session span is emitted once, not again on the next pull", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    session_started_at: "2026-05-21T12:00:00.000Z",
    session_ended_at: "2026-05-21T12:30:00.000Z",
    last_event_at: "2026-05-21T12:30:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "session.start",
  });

  const source = openSource(path);
  const first = source.pullTraces(null);
  expect(first.sessionSpans).toHaveLength(1);

  const second = source.pullTraces(first.nextWatermark);
  source.close();
  db.close();

  expect(second.sessionSpans).toHaveLength(0);
});

test("a point event is emitted once, not again on the next pull", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "user_prompt",
    timestamp: "2026-05-21T12:01:00.000Z",
  });

  const source = openSource(path);
  const first = source.pullTraces(null);
  expect(first.pointEvents).toHaveLength(1);

  const second = source.pullTraces(first.nextWatermark);
  source.close();
  db.close();

  expect(second.pointEvents).toHaveLength(0);
});

test("a tool call that closes after a pull is emitted on the next pull", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, { session_id: "sess-a", trace_id: TRACE_ID });
  insertToolCallSpan(db, {
    session_id: "sess-a",
    tool_call_id: "tc-late",
    started_at: "2026-05-21T12:01:00.000Z",
    ended_at: null,
  });

  const source = openSource(path);
  const first = source.pullTraces(null);
  expect(first.toolSpans).toHaveLength(0);

  // The tool call completes after the first pull.
  db.prepare(
    "UPDATE tool_call_spans SET ended_at = ? WHERE session_id = ? AND tool_call_id = ?",
  ).run("2026-05-21T12:02:00.000Z", "sess-a", "tc-late");
  const second = source.pullTraces(first.nextWatermark);
  source.close();
  db.close();

  expect(second.toolSpans.map((t) => t.toolCallId)).toEqual(["tc-late"]);
});

test("a tool call closing at an already-emitted millisecond is still emitted", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    last_event_at: "2026-05-21T12:05:00.000Z",
  });
  insertEvent(db, { session_id: "sess-a", trace_id: TRACE_ID });
  insertToolCallSpan(db, {
    session_id: "sess-a",
    tool_call_id: "tc-1",
    started_at: "2026-05-21T12:01:00.000Z",
    ended_at: "2026-05-21T12:02:00.000Z",
  });

  const source = openSource(path);
  const first = source.pullTraces(null);
  expect(first.toolSpans.map((t) => t.toolCallId)).toEqual(["tc-1"]);

  // A second tool call closes at the exact same millisecond as the first.
  insertToolCallSpan(db, {
    session_id: "sess-a",
    tool_call_id: "tc-2",
    started_at: "2026-05-21T12:01:30.000Z",
    ended_at: "2026-05-21T12:02:00.000Z",
  });
  const second = source.pullTraces(first.nextWatermark);
  source.close();
  db.close();

  expect(second.toolSpans.map((t) => t.toolCallId)).toEqual(["tc-2"]);
});

test("a pre-rebuild plain-timestamp watermark is re-read from the start", () => {
  const path = tempDbPath();
  const db = createFeedbackDb(path);
  insertConversation(db, {
    session_id: "sess-a",
    session_started_at: "2026-05-21T12:00:00.000Z",
    session_ended_at: "2026-05-21T12:30:00.000Z",
    last_event_at: "2026-05-21T12:30:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-a",
    trace_id: TRACE_ID,
    event_type: "user_prompt",
  });

  const source = openSource(path);
  // The watermark written by the pre-emit-once bridge was a plain timestamp.
  const batch = source.pullTraces("2026-05-21T12:30:00.000Z");
  source.close();
  db.close();

  expect(batch.sessionSpans).toHaveLength(1);
  expect(batch.pointEvents).toHaveLength(1);
});
