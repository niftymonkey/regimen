/**
 * Selection behavior of a bulk-judging sweep, observed through
 * selectSessionsToJudge.
 *
 * Each test seeds a temp store with conversation rows (some judged via
 * writeAssessment, some not), then asserts which sessions the selector returns.
 * Pure SQLite read: no Judge, no network, no writes. The store helpers mirror
 * sessions.test.ts, the template for this read layer.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStore, type Store } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult, OutcomeValue } from "../src/judged/types.ts";
import type { SessionSummary } from "../src/sessions.ts";
import {
  runSweep,
  selectSessionsToJudge,
  type BatchDecision,
} from "../src/judged/sweep.ts";

const NOW = () => Date.parse("2026-06-15T12:00:00.000Z");
const ASSIGNMENT = "whole-conversation";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-sweep-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-sweep-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A judge that records each conversation it is handed and always succeeds. */
function recordingJudge(): {
  judge: (session: SessionSummary) => Promise<void>;
  calls: SessionSummary[];
} {
  const calls: SessionSummary[] = [];
  return {
    judge: async (session) => {
      calls.push(session);
    },
    calls,
  };
}

function seedSession(
  db: Database,
  opts: {
    sessionId: string;
    harness: string;
    model: string | null;
    firstEventAt: string;
    lastEventAt: string;
    eventCount?: number;
  },
): void {
  const count = opts.eventCount ?? 1;
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO events
         (event_hash, schema_version, trace_id, session_id, timestamp,
          harness, model, event_type, span_phase, span_name, attributes)
       VALUES (randomblob(32), 1, ?, ?, ?, ?, ?, 'user_prompt', 'point', 'user_prompt', ?)`,
    ).run(
      `trace-${opts.sessionId}`,
      opts.sessionId,
      opts.lastEventAt,
      opts.harness,
      opts.model,
      JSON.stringify({ i: String(i) }),
    );
  }
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.sessionId,
    opts.harness,
    opts.model,
    opts.firstEventAt,
    opts.lastEventAt,
  );
}

function run(sessionId: string, runId: string): AssessmentRunIdentity {
  return {
    runId,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-06-15T10:00:00.000Z",
  };
}

/** A complete verdict carrying the given whole-conversation Outcome value. */
function resultWithOutcome(outcome: OutcomeValue): JudgeResult {
  return {
    complete: true,
    provenance: {
      judgeModel: "judge-model",
      rubricVersion: "2026-06-15",
      promptVersion: "2026-06-15",
    },
    signals: [
      {
        scope: "assignment",
        assignmentId: ASSIGNMENT,
        signalName: "outcome",
        valueKind: "ordinal",
        value: outcome,
        anchors: [{ eventHash: "b".repeat(64) }],
      },
    ],
    narratives: [
      {
        scope: "conversation",
        narrativeType: "assessment",
        prose: "The agent built the feature.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

/** Seed one judged conversation and one unjudged conversation. */
function seedJudgedAndUnjudged(store: Store): void {
  seedSession(store.db, {
    sessionId: "judged",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T10:00:00.000Z",
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  writeAssessment(
    store,
    run("judged", "run-j"),
    resultWithOutcome("accomplished-cleanly"),
  );
  seedSession(store.db, {
    sessionId: "unjudged",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-14T10:00:00.000Z",
    lastEventAt: "2026-06-14T10:30:00.000Z",
  });
}

test("selectSessionsToJudge with force:false returns only unjudged conversations", () => {
  withStore((store) => {
    seedJudgedAndUnjudged(store);
    const ids = selectSessionsToJudge(store.db, {}, { force: false }, NOW).map(
      (s) => s.sessionId,
    );
    expect(ids).toEqual(["unjudged"]);
  });
});

test("selectSessionsToJudge with force:true returns judged and unjudged conversations alike", () => {
  withStore((store) => {
    seedJudgedAndUnjudged(store);
    const ids = selectSessionsToJudge(store.db, {}, { force: true }, NOW)
      .map((s) => s.sessionId)
      .sort();
    expect(ids).toEqual(["judged", "unjudged"]);
  });
});

test("selectSessionsToJudge passes the filter through to listSessions", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "claude-sess",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    seedSession(store.db, {
      sessionId: "gemini-sess",
      harness: "gemini",
      model: "gemini-2.5",
      firstEventAt: "2026-06-15T09:00:00.000Z",
      lastEventAt: "2026-06-15T09:30:00.000Z",
    });
    const ids = selectSessionsToJudge(
      store.db,
      { harness: "claude" },
      { force: false },
      NOW,
    ).map((s) => s.sessionId);
    expect(ids).toEqual(["claude-sess"]);
  });
});

test("runSweep judges every selected conversation in one batch and never asks to continue", async () => {
  await withStoreAsync(async (store) => {
    seedSession(store.db, {
      sessionId: "a",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    seedSession(store.db, {
      sessionId: "b",
      harness: "gemini",
      model: "gemini-2.5",
      firstEventAt: "2026-06-15T09:00:00.000Z",
      lastEventAt: "2026-06-15T09:30:00.000Z",
    });
    const { judge, calls } = recordingJudge();
    let decisions = 0;
    const decideNextBatch = async (): Promise<BatchDecision> => {
      decisions++;
      return "continue";
    };
    const summary = await runSweep(store.db, {
      filter: {},
      force: false,
      batchSize: 10,
      judge,
      decideNextBatch,
      now: NOW,
    });
    expect(calls.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(summary.judged.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(decisions).toBe(0);
  });
});

/** Seed three unjudged conversations, newest-first as s1, s2, s3. */
function seedThree(store: Store): void {
  seedSession(store.db, {
    sessionId: "s1",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T10:00:00.000Z",
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedSession(store.db, {
    sessionId: "s2",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T09:00:00.000Z",
    lastEventAt: "2026-06-15T09:30:00.000Z",
  });
  seedSession(store.db, {
    sessionId: "s3",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T08:00:00.000Z",
    lastEventAt: "2026-06-15T08:30:00.000Z",
  });
}

test("runSweep pauses between batches and continue advances to the next batch", async () => {
  await withStoreAsync(async (store) => {
    seedThree(store);
    const { judge, calls } = recordingJudge();
    let decisions = 0;
    let callsAtDecision = -1;
    const decideNextBatch = async (): Promise<BatchDecision> => {
      decisions++;
      callsAtDecision = calls.length;
      return "continue";
    };
    const summary = await runSweep(store.db, {
      filter: {},
      force: false,
      batchSize: 2,
      judge,
      decideNextBatch,
      now: NOW,
    });
    // The prompt fired only after the first full batch (s1, s2) finished, never
    // mid-batch, then the third conversation ran.
    expect(callsAtDecision).toBe(2);
    expect(calls.length).toBe(3);
    expect(summary.judged.length).toBe(3);
    expect(decisions).toBe(1);
  });
});

test("runSweep quits between batches and leaves the remaining conversations skipped", async () => {
  await withStoreAsync(async (store) => {
    seedThree(store);
    const { judge, calls } = recordingJudge();
    const decideNextBatch = async (): Promise<BatchDecision> => "quit";
    const summary = await runSweep(store.db, {
      filter: {},
      force: false,
      batchSize: 1,
      judge,
      decideNextBatch,
      now: NOW,
    });
    expect(calls.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(summary.judged.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(summary.skipped.map((s) => s.sessionId)).toEqual(["s2", "s3"]);
    expect(summary.failed).toEqual([]);
  });
});

test("runSweep runs all remaining batches without asking again after all", async () => {
  await withStoreAsync(async (store) => {
    seedThree(store);
    const { judge, calls } = recordingJudge();
    let decisions = 0;
    let callsAtDecision = -1;
    const decideNextBatch = async (): Promise<BatchDecision> => {
      decisions++;
      callsAtDecision = calls.length;
      return "all";
    };
    const summary = await runSweep(store.db, {
      filter: {},
      force: false,
      batchSize: 1,
      judge,
      decideNextBatch,
      now: NOW,
    });
    // The prompt fired after the first one-conversation batch, then the rest ran
    // without asking again.
    expect(callsAtDecision).toBe(1);
    expect(calls.length).toBe(3);
    expect(summary.judged.length).toBe(3);
    expect(summary.skipped).toEqual([]);
    expect(decisions).toBe(1);
  });
});

test("runSweep records a failed judge and continues with the rest", async () => {
  await withStoreAsync(async (store) => {
    seedThree(store);
    const seen: string[] = [];
    const boom = new Error("transcript missing");
    const judge = async (session: SessionSummary): Promise<void> => {
      seen.push(session.sessionId);
      if (session.sessionId === "s2") {
        throw boom;
      }
    };
    const decideNextBatch = async (): Promise<BatchDecision> => "continue";
    const summary = await runSweep(store.db, {
      filter: {},
      force: false,
      batchSize: 10,
      judge,
      decideNextBatch,
      now: NOW,
    });
    expect(seen).toEqual(["s1", "s2", "s3"]);
    expect(summary.judged.map((s) => s.sessionId)).toEqual(["s1", "s3"]);
    expect(summary.failed.map((f) => f.session.sessionId)).toEqual(["s2"]);
    expect(summary.failed[0]!.error).toBe(boom);
    expect(summary.skipped).toEqual([]);
  });
});

test("runSweep rejects a non-positive batchSize and judges nothing", async () => {
  await withStoreAsync(async (store) => {
    seedThree(store);
    const { judge, calls } = recordingJudge();
    await expect(
      runSweep(store.db, {
        filter: {},
        force: false,
        batchSize: 0,
        judge,
        decideNextBatch: async (): Promise<BatchDecision> => "continue",
        now: NOW,
      }),
    ).rejects.toThrow(/positive integer/);
    expect(calls.length).toBe(0);
  });
});
