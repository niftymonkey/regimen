/**
 * The read-time harness/model slice on the judged store (B.1, ADR-0008).
 *
 * Harness and model are kept OFF the judged rows and recovered as read-time
 * slice dimensions by joining `conversations` on session_id. Each test seeds a
 * store with judged rows (via the writer) and conversation rows (inserted
 * directly, as the loader would), then asserts on what the slice reads back.
 * Pure SQLite read: no Judge, no network, no writes.
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
import { readJudgmentDigest } from "../src/judged/digest.ts";
import {
  listJudgedSessions,
  sessionHarnessModel,
} from "../src/judged/slice.ts";

const FIXED = () => Date.parse("2026-06-15T12:00:00.000Z");

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-jslice-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const ASSIGNMENT = "whole-conversation";

/** Seed a conversation row the way the loader would, with model possibly null. */
function seedConversation(
  db: Database,
  sessionId: string,
  harness: string,
  model: string | null,
): void {
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    harness,
    model,
    "2026-06-15T10:00:00.000Z",
    "2026-06-15T10:30:00.000Z",
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
        scope: "conversation",
        assignmentId: ASSIGNMENT,
        signalName: "intent",
        valueKind: "categorical",
        value: "feature",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
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

test("sessionHarnessModel recovers a seeded session's harness and model", () => {
  withStore((store) => {
    seedConversation(store.db, "sess-a", "claude", "claude-opus-4-8");
    const slice = sessionHarnessModel(store.db, "sess-a");
    expect(slice).toEqual({ harness: "claude", model: "claude-opus-4-8" });
  });
});

test("sessionHarnessModel returns null for a session with no conversation row", () => {
  withStore((store) => {
    expect(sessionHarnessModel(store.db, "never-seen")).toBeNull();
  });
});

test("sessionHarnessModel surfaces model: null when the column is null", () => {
  withStore((store) => {
    seedConversation(store.db, "sess-null", "codex", null);
    const slice = sessionHarnessModel(store.db, "sess-null");
    expect(slice).toEqual({ harness: "codex", model: null });
  });
});

/**
 * Seed two judged sessions across two harnesses and two models, plus one
 * unjudged session (conversation row, no assessment run). Returns the store.
 */
function seedSlice(store: Store): void {
  seedConversation(store.db, "sess-claude", "claude", "claude-opus-4-8");
  writeAssessment(
    store,
    run("sess-claude", "run-c"),
    resultWithOutcome("accomplished-cleanly"),
  );

  seedConversation(store.db, "sess-codex", "codex", "gpt-5");
  writeAssessment(
    store,
    run("sess-codex", "run-x"),
    resultWithOutcome("partial"),
  );

  // Unjudged: a conversation with no assessment run must not appear.
  seedConversation(store.db, "sess-unjudged", "claude", "claude-opus-4-8");
}

test("listJudgedSessions returns one row per judged session with harness, model, and outcome", () => {
  withStore((store) => {
    seedSlice(store);
    const rows = listJudgedSessions(store.db);
    const bySession = new Map(rows.map((r) => [r.sessionId, r]));
    expect(rows.length).toBe(2);
    expect(bySession.get("sess-claude")).toEqual({
      sessionId: "sess-claude",
      harness: "claude",
      model: "claude-opus-4-8",
      complete: true,
      outcome: "accomplished-cleanly",
    });
    expect(bySession.get("sess-codex")).toEqual({
      sessionId: "sess-codex",
      harness: "codex",
      model: "gpt-5",
      complete: true,
      outcome: "partial",
    });
  });
});

test("listJudgedSessions excludes a session with no assessment run", () => {
  withStore((store) => {
    seedSlice(store);
    const ids = listJudgedSessions(store.db).map((r) => r.sessionId);
    expect(ids).not.toContain("sess-unjudged");
  });
});

test("listJudgedSessions filters by harness", () => {
  withStore((store) => {
    seedSlice(store);
    const rows = listJudgedSessions(store.db, { harness: "codex" });
    expect(rows.map((r) => r.sessionId)).toEqual(["sess-codex"]);
  });
});

test("listJudgedSessions filters by model", () => {
  withStore((store) => {
    seedSlice(store);
    const rows = listJudgedSessions(store.db, { model: "claude-opus-4-8" });
    expect(rows.map((r) => r.sessionId)).toEqual(["sess-claude"]);
  });
});

test("listJudgedSessions surfaces complete=false and a null outcome for an abstaining run", () => {
  withStore((store) => {
    seedConversation(store.db, "sess-inc", "gemini", "gemini-2.5");
    const incomplete: JudgeResult = {
      ...resultWithOutcome("partial"),
      complete: false,
      incompleteReason: "insufficient-evidence",
      // The Outcome abstains; only Intent stands.
      signals: resultWithOutcome("partial").signals.filter(
        (s) => s.signalName === "intent",
      ),
    };
    writeAssessment(store, run("sess-inc", "run-i"), incomplete);
    const rows = listJudgedSessions(store.db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.complete).toBe(false);
    expect(rows[0]!.outcome).toBeNull();
  });
});

test("listJudgedSessions reflects only the latest run after a re-judge", () => {
  withStore((store) => {
    seedConversation(store.db, "sess-rj", "claude", "claude-opus-4-8");
    writeAssessment(
      store,
      { ...run("sess-rj", "run-1"), createdAt: "2026-06-15T10:00:00.000Z" },
      resultWithOutcome("accomplished-cleanly"),
    );
    writeAssessment(
      store,
      { ...run("sess-rj", "run-2"), createdAt: "2026-06-15T11:00:00.000Z" },
      resultWithOutcome("partial"),
    );
    const rows = listJudgedSessions(store.db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe("partial");
  });
});

test("the judged digest carries the session's harness and model recovered by join", () => {
  withStore((store) => {
    seedConversation(store.db, "sess-claude", "claude", "claude-opus-4-8");
    writeAssessment(
      store,
      run("sess-claude", "run-c"),
      resultWithOutcome("accomplished-cleanly"),
    );
    const digest = readJudgmentDigest(store.db, "sess-claude", FIXED);
    expect(digest.judged).toBe(true);
    if (digest.judged !== true) return;
    expect(digest.harness).toBe("claude");
    expect(digest.model).toBe("claude-opus-4-8");
  });
});

test("the judged digest surfaces model: null when the conversation model is null", () => {
  withStore((store) => {
    seedConversation(store.db, "sess-null", "codex", null);
    writeAssessment(
      store,
      run("sess-null", "run-n"),
      resultWithOutcome("partial"),
    );
    const digest = readJudgmentDigest(store.db, "sess-null", FIXED);
    expect(digest.judged).toBe(true);
    if (digest.judged !== true) return;
    expect(digest.harness).toBe("codex");
    expect(digest.model).toBeNull();
  });
});
