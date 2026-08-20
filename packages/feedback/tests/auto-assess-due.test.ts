/**
 * The nightly sweep's due rule (ADR-0018).
 *
 * A conversation already carrying a verdict is due again only when it has
 * grown past what that verdict covered, by at least a quarter of the covered
 * events with a floor of twenty, so trivial regrowth does not spend a call.
 */
import { expect, test } from "bun:test";
import { hasGrownPastWatermark } from "../src/judged/auto-assess.ts";

test("growth below the twenty-event floor is not enough", () => {
  expect(hasGrownPastWatermark(200, 219)).toBe(false);
});

test("twenty new events past a short conversation's watermark is enough", () => {
  expect(hasGrownPastWatermark(40, 60)).toBe(true);
});

test("a long conversation needs a quarter of its covered events, not just twenty", () => {
  expect(hasGrownPastWatermark(200, 240)).toBe(false);
});

test("a quarter past a long conversation's watermark is enough", () => {
  expect(hasGrownPastWatermark(200, 250)).toBe(true);
});

test("a verdict written before the watermark existed is never re-judged on growth", () => {
  expect(hasGrownPastWatermark(null, 5000)).toBe(false);
});

/**
 * Selection over a real store: the nightly sweep re-selects a judged
 * conversation only when it has grown past its own watermark.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent } from "../hooks/event-log.ts";
import { openStore, type Store } from "../src/store.ts";
import { runSweep, selectSessionsToJudge } from "../src/judged/sweep.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult } from "../src/judged/types.ts";

const ASSIGNMENT = "whole-conversation";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-auto-assess-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function event(sessionId: string, timestamp: string): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "gemini",
    model: "gemini-3-pro",
    event_type: "user_prompt",
    trace_id: traceIdFor(sessionId),
    span_phase: "point",
    span_name: "user_prompt",
    attributes: { text: timestamp },
  };
}

/** Seed `count` events a minute apart, starting at 2026-08-01T00:00Z. */
function seedEvents(store: Store, sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 60_000);
    store.insertEvent(event(sessionId, at.toISOString()));
  }
}

function verdictFor(store: Store, sessionId: string, runId: string): void {
  const run: AssessmentRunIdentity = {
    runId,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-08-02T00:00:00.000Z",
  };
  const result: JudgeResult = {
    complete: true,
    provenance: {
      judgeModel: "test-model",
      rubricVersion: "2026-06-15",
      promptVersion: "2026-06-15",
    },
    signals: [],
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
  return writeAssessment(store, run, result);
}

const GROWN = "019e0000-3333-7000-8000-00000000cc01";
const STEADY = "019e0000-3333-7000-8000-00000000cc02";

test("a judged conversation that grew past its watermark is selected again", () => {
  withStore((store) => {
    seedEvents(store, GROWN, 40);
    verdictFor(store, GROWN, "run-grown");
    seedEvents(store, STEADY, 40);
    verdictFor(store, STEADY, "run-steady");

    // Only GROWN gains events after its verdict.
    for (let i = 0; i < 25; i++) {
      const at = new Date(Date.parse("2026-08-03T00:00:00.000Z") + i * 60_000);
      store.insertEvent(event(GROWN, at.toISOString()));
    }

    const selected = selectSessionsToJudge(
      store.db,
      {},
      { force: false, growth: true },
    );

    expect(selected.map((s) => s.sessionId)).toEqual([GROWN]);
  });
});

test("the nightly cap judges the conversations closest to aging out first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-auto-assess-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    const oldest = "019e0000-4444-7000-8000-00000000dd01";
    const middle = "019e0000-4444-7000-8000-00000000dd02";
    const newest = "019e0000-4444-7000-8000-00000000dd03";
    store.insertEvent(event(oldest, "2026-07-01T00:00:00.000Z"));
    store.insertEvent(event(middle, "2026-07-15T00:00:00.000Z"));
    store.insertEvent(event(newest, "2026-08-01T00:00:00.000Z"));

    const seen: string[] = [];
    const summary = await runSweep(store.db, {
      filter: {},
      force: false,
      batchSize: 10,
      limit: 2,
      judge: async (session) => {
        seen.push(session.sessionId);
      },
      decideNextBatch: async () => "all",
    });

    expect(seen).toEqual([oldest, middle]);
    expect(summary.judged.length).toBe(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sweep in growth mode re-judges a grown conversation without --force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-auto-assess-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    const grown = "019e0000-5555-7000-8000-00000000ee01";
    seedEvents(store, grown, 40);
    verdictFor(store, grown, "run-a");
    for (let i = 0; i < 25; i++) {
      const at = new Date(Date.parse("2026-08-03T00:00:00.000Z") + i * 60_000);
      store.insertEvent(event(grown, at.toISOString()));
    }

    const seen: string[] = [];
    await runSweep(store.db, {
      filter: {},
      force: false,
      growth: true,
      batchSize: 10,
      judge: async (session) => {
        seen.push(session.sessionId);
      },
      decideNextBatch: async () => "all",
    });

    expect(seen).toEqual([grown]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
