/**
 * The verdict-rollup deterministic header, observed through rollupHeader.
 *
 * The header is the source of truth for ALL numbers in a rollup: the count of
 * judged conversations and their Outcome distribution come straight from SQL,
 * never from the synthesis model. Each test seeds judged conversations (via the
 * writer) and conversation rows (inserted directly, as the loader would), then
 * asserts the counts the header reports. The seeding mirrors judged-slice.test.ts,
 * the template for this judged read layer. Pure SQLite read: no Judge, no network.
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
import { rollupHeader } from "../src/judged/rollup.ts";

const ASSIGNMENT = "whole-conversation";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-rollup-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedConversation(db: Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
  ).run(sessionId, "2026-06-15T10:00:00.000Z", "2026-06-15T10:30:00.000Z");
}

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
        prose: "The agent did the work.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

function judge(store: Store, sessionId: string, outcome: OutcomeValue): void {
  const run: AssessmentRunIdentity = {
    runId: `run-${sessionId}`,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-06-15T10:00:00.000Z",
  };
  seedConversation(store.db, sessionId);
  writeAssessment(store, run, resultWithOutcome(outcome));
}

test("rollupHeader counts judged verdicts by outcome, worst to best, excluding unjudged", () => {
  withStore((store) => {
    judge(store, "a", "accomplished-cleanly");
    judge(store, "b", "accomplished-cleanly");
    judge(store, "c", "partial");
    judge(store, "d", "abandoned");
    // An unjudged conversation must not count toward the rollup.
    seedConversation(store.db, "unjudged");

    const header = rollupHeader(store.db);

    expect(header.totalJudged).toBe(4);
    expect(header.distribution).toEqual([
      { outcome: "abandoned", count: 1 },
      { outcome: "partial", count: 1 },
      { outcome: "accomplished-cleanly", count: 2 },
    ]);
  });
});
