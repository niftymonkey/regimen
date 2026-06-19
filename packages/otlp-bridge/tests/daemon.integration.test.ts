import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/daemon.ts";
import { openSource } from "../src/source/source.ts";
import { openWatermarkStore } from "../src/state/watermarks.ts";
import type { SignalStream } from "../src/state/watermarks.ts";
import { recordingExporter } from "../src/exporter/recording.ts";
import type { Exporter } from "../src/exporter/port.ts";
import type { DaemonLog } from "../src/operational-log.ts";
import type { ProjectionOptions } from "../src/projection/resource.ts";
import {
  createFeedbackDb,
  insertConversation,
  insertEvent,
  insertToolCallSpan,
  type EventSeed,
} from "./fixtures/feedback-db.ts";
import type { Database } from "bun:sqlite";

const OPTIONS: ProjectionOptions = {
  serviceName: "regimen",
  serviceVersion: "0.0.0",
  environment: "test",
  scopeName: "regimen-otlp-bridge",
  scopeVersion: "0.0.0",
};

/** A temp directory holding a feedback.db and a watermarks file. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "regimen-bridge-daemon-"));
}

/** Seed one fully closed session: five events and a closed tool span. */
function seedClosedSession(db: Database): void {
  insertConversation(db, {
    session_id: "sess-1",
    harness: "claude",
    model: "claude-opus-4-7",
    session_started_at: "2026-05-21T12:00:00.000Z",
    session_ended_at: "2026-05-21T12:00:30.000Z",
    first_event_at: "2026-05-21T12:00:00.000Z",
    last_event_at: "2026-05-21T12:00:30.000Z",
  });
  const events: EventSeed[] = [
    {
      event_type: "session.start",
      span_phase: "start",
      span_name: "session",
      timestamp: "2026-05-21T12:00:00.000Z",
    },
    {
      event_type: "user_prompt",
      span_name: "user_prompt",
      timestamp: "2026-05-21T12:00:01.000Z",
    },
    {
      event_type: "tool.pre",
      span_phase: "start",
      span_name: "tool:Bash",
      timestamp: "2026-05-21T12:00:02.000Z",
      attributes: { tool_name: "Bash", tool_call_id: "tc-1" },
    },
    {
      event_type: "tool.post",
      span_phase: "end",
      span_name: "tool:Bash",
      timestamp: "2026-05-21T12:00:03.000Z",
      attributes: { tool_name: "Bash", tool_call_id: "tc-1" },
    },
    {
      event_type: "session.end",
      span_phase: "end",
      span_name: "session",
      timestamp: "2026-05-21T12:00:30.000Z",
    },
  ];
  for (const event of events)
    insertEvent(db, { session_id: "sess-1", ...event });
  insertToolCallSpan(db, {
    session_id: "sess-1",
    tool_call_id: "tc-1",
    tool_name: "Bash",
    started_at: "2026-05-21T12:00:02.000Z",
    ended_at: "2026-05-21T12:00:03.000Z",
    duration_ms: 1000,
  });
}

test("one tick sends a payload on all three signal streams", async () => {
  const dir = tempDir();
  const db = createFeedbackDb(join(dir, "feedback.db"));
  seedClosedSession(db);

  const exporter = recordingExporter();
  const daemon = createDaemon({
    source: openSource(join(dir, "feedback.db")),
    state: openWatermarkStore(join(dir, "watermarks.json")),
    exporter,
    options: OPTIONS,
  });

  await daemon.tick();
  daemon.stop();
  db.close();

  expect(exporter.sent.map((p) => p.stream).sort()).toEqual([
    "logs",
    "metrics",
    "traces",
  ]);
});

test("a tick commits a watermark for every stream it sent", async () => {
  const dir = tempDir();
  const db = createFeedbackDb(join(dir, "feedback.db"));
  seedClosedSession(db);

  const state = openWatermarkStore(join(dir, "watermarks.json"));
  const daemon = createDaemon({
    source: openSource(join(dir, "feedback.db")),
    state,
    exporter: recordingExporter(),
    options: OPTIONS,
  });

  await daemon.tick();
  daemon.stop();
  db.close();

  expect(state.read("logs")).not.toBeNull();
  expect(state.read("metrics")).not.toBeNull();
  expect(state.read("traces")).not.toBeNull();
});

test("a tick against an empty store sends nothing", async () => {
  const dir = tempDir();
  const db = createFeedbackDb(join(dir, "feedback.db"));

  const exporter = recordingExporter();
  const daemon = createDaemon({
    source: openSource(join(dir, "feedback.db")),
    state: openWatermarkStore(join(dir, "watermarks.json")),
    exporter,
    options: OPTIONS,
  });

  await daemon.tick();
  daemon.stop();
  db.close();

  expect(exporter.sent).toHaveLength(0);
});

test("a restarted daemon resumes from the watermark and re-emits no logs", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "feedback.db");
  const wmPath = join(dir, "watermarks.json");
  const db = createFeedbackDb(dbPath);
  seedClosedSession(db);

  // First daemon emits the seeded session, then stops.
  const daemon1 = createDaemon({
    source: openSource(dbPath),
    state: openWatermarkStore(wmPath),
    exporter: recordingExporter(),
    options: OPTIONS,
  });
  await daemon1.tick();
  daemon1.stop();

  // A new event lands while the bridge is down.
  insertConversation(db, {
    session_id: "sess-2",
    last_event_at: "2026-05-21T13:00:00.000Z",
  });
  insertEvent(db, {
    session_id: "sess-2",
    event_type: "user_prompt",
    timestamp: "2026-05-21T13:00:00.000Z",
  });

  // A fresh daemon on the same watermark file.
  const exporter2 = recordingExporter();
  const daemon2 = createDaemon({
    source: openSource(dbPath),
    state: openWatermarkStore(wmPath),
    exporter: exporter2,
    options: OPTIONS,
  });
  await daemon2.tick();
  daemon2.stop();
  db.close();

  const logsPayload = exporter2.sent.find((p) => p.stream === "logs");
  if (logsPayload?.stream !== "logs") {
    throw new Error("expected a logs payload from the restarted daemon");
  }
  const records = logsPayload.data.resourceLogs.flatMap((rl) =>
    rl.scopeLogs.flatMap((sl) => sl.logRecords),
  );
  expect(records).toHaveLength(1);
  const sessionAttr = records[0]!.attributes.find(
    (a) => a.key === "session_id",
  );
  expect(sessionAttr).toBeDefined();
  expect(sessionAttr!.value.stringValue).toBe("sess-2");
});

test("a tick reports the cycle and each delivered stream to the log", async () => {
  const dir = tempDir();
  const db = createFeedbackDb(join(dir, "feedback.db"));
  seedClosedSession(db);

  const delivered: { stream: SignalStream; records: number }[] = [];
  let ticks = 0;
  const log: DaemonLog = {
    tick: () => {
      ticks += 1;
    },
    delivered: (stream, records) => {
      delivered.push({ stream, records });
    },
    sendFailed: () => {},
    anomaly: () => {},
  };
  const daemon = createDaemon({
    source: openSource(join(dir, "feedback.db")),
    state: openWatermarkStore(join(dir, "watermarks.json")),
    exporter: recordingExporter(),
    options: OPTIONS,
    log,
  });

  await daemon.tick();
  daemon.stop();
  db.close();

  expect(ticks).toBe(1);
  expect(delivered.map((d) => d.stream).sort()).toEqual([
    "logs",
    "metrics",
    "traces",
  ]);
  expect(delivered.every((d) => d.records > 0)).toBe(true);
});

test("a tick reports a rejected stream to the log as a send failure", async () => {
  const dir = tempDir();
  const db = createFeedbackDb(join(dir, "feedback.db"));
  seedClosedSession(db);

  const failed: { stream: SignalStream; error: string }[] = [];
  const rejectingExporter: Exporter = {
    send: () => Promise.resolve({ ok: false, error: "boom" }),
  };
  const log: DaemonLog = {
    tick: () => {},
    delivered: () => {},
    sendFailed: (stream, error) => {
      failed.push({ stream, error });
    },
    anomaly: () => {},
  };
  const daemon = createDaemon({
    source: openSource(join(dir, "feedback.db")),
    state: openWatermarkStore(join(dir, "watermarks.json")),
    exporter: rejectingExporter,
    options: OPTIONS,
    log,
  });

  await daemon.tick();
  daemon.stop();
  db.close();

  expect(failed.map((f) => f.stream).sort()).toEqual([
    "logs",
    "metrics",
    "traces",
  ]);
  expect(failed.every((f) => f.error === "boom")).toBe(true);
});
