/**
 * The coverage watermark on assessment_run (ADR-0018).
 *
 * A verdict records how much of the conversation it covered, so a later sweep
 * can tell a conversation that grew after being judged from one that did not.
 * The writer stamps the conversation's own `last_event_at` and event count at
 * judge time; each test seeds a store through the public write path
 * (openStore + insertEvent), writes one assessment, and reads the row back.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent } from "../hooks/event-log.ts";
import { openStore, type Store } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult } from "../src/judged/types.ts";

const SESSION = "019e0000-2222-7000-8000-00000000bbbb";
const ASSIGNMENT = "whole-conversation";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-watermark-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function promptEvent(sessionId: string, timestamp: string): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "codex",
    model: "gpt-5",
    event_type: "user_prompt",
    trace_id: traceIdFor(sessionId),
    span_phase: "point",
    span_name: "user_prompt",
    attributes: { text: timestamp },
  };
}

function verdict(): JudgeResult {
  return {
    complete: true,
    provenance: {
      judgeModel: "test-model",
      rubricVersion: "2026-06-15",
      promptVersion: "2026-06-15",
    },
    signals: [
      {
        scope: "conversation",
        assignmentId: ASSIGNMENT,
        signalName: "intent",
        valueKind: "categorical",
        value: "feature",
        anchors: [],
      },
    ],
    narratives: [
      {
        scope: "assignment",
        assignmentId: ASSIGNMENT,
        narrativeType: "assessment",
        prose: "it went fine",
        anchors: [],
      },
    ],
  };
}

interface WatermarkRow {
  covered_last_event_at: string | null;
  covered_event_count: number | null;
}

function watermarkOf(store: Store, runId: string): WatermarkRow {
  return store.db
    .prepare(
      "SELECT covered_last_event_at, covered_event_count FROM assessment_run WHERE run_id = ?",
    )
    .get(runId) as WatermarkRow;
}

test("a written verdict records the conversation's last event and event count", () => {
  withStore((store) => {
    store.insertEvent(promptEvent(SESSION, "2026-08-01T10:00:00.000Z"));
    store.insertEvent(promptEvent(SESSION, "2026-08-01T10:05:00.000Z"));
    store.insertEvent(promptEvent(SESSION, "2026-08-01T10:09:00.000Z"));

    const run: AssessmentRunIdentity = {
      runId: "run-1",
      sessionId: SESSION,
      assignmentId: ASSIGNMENT,
      createdAt: "2026-08-02T11:00:00.000Z",
    };
    writeAssessment(store, run, verdict());

    expect(watermarkOf(store, "run-1")).toEqual({
      covered_last_event_at: "2026-08-01T10:09:00.000Z",
      covered_event_count: 3,
    });
  });
});
