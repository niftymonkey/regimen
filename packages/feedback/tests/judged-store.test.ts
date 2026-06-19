/**
 * Judged-store migration and writer behavior (S3, ADR-0008).
 *
 * The judged store is migration v6 on the shared ledger: the four ADR-0008
 * tables (assessment_run, assignment, judged_signal, narrative). The writer
 * persists one run's verdict and supersedes a prior run per the supersede key.
 * Each test seeds a store with openStore and asserts on the rows the writer
 * leaves, observed through the public read path.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult } from "../src/judged/types.ts";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-judged-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SESSION = "019e0000-1111-7000-8000-00000000aaaa";
const ASSIGNMENT = "whole-conversation";

function run(runId: string, createdAt: string): AssessmentRunIdentity {
  return { runId, sessionId: SESSION, assignmentId: ASSIGNMENT, createdAt };
}

/** A complete verdict with Intent, Outcome, and the assessment narrative. */
function fullResult(judgeModel = "claude-opus-4-8"): JudgeResult {
  return {
    complete: true,
    provenance: {
      judgeModel,
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
        value: "accomplished-cleanly",
        anchors: [{ eventHash: "b".repeat(64) }],
      },
    ],
    narratives: [
      {
        scope: "conversation",
        narrativeType: "assessment",
        prose: "The agent built the feature with light steering.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

test("migration v6 creates the four ADR-0008 judged tables", () => {
  withStore((store) => {
    const tables = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as ReadonlyArray<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    expect(names.has("assessment_run")).toBe(true);
    expect(names.has("assignment")).toBe(true);
    expect(names.has("judged_signal")).toBe(true);
    expect(names.has("narrative")).toBe(true);
  });
});

test("writeAssessment persists one run, one assignment, the signals, and the narrative", () => {
  withStore((store) => {
    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      fullResult(),
    );

    const runs = store.db
      .prepare(
        "SELECT run_id, session_id, complete, judge_model FROM assessment_run",
      )
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(runs.length).toBe(1);
    expect(runs[0]!.run_id).toBe("run-1");
    expect(runs[0]!.session_id).toBe(SESSION);
    expect(runs[0]!.complete).toBe(1);
    expect(runs[0]!.judge_model).toBe("claude-opus-4-8");

    const assignments = store.db
      .prepare("SELECT session_id, assignment_id FROM assignment")
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(assignments.length).toBe(1);
    expect(assignments[0]!.assignment_id).toBe(ASSIGNMENT);

    const signals = store.db
      .prepare(
        "SELECT signal_name, value_kind, value, run_id FROM judged_signal ORDER BY signal_name",
      )
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(signals.map((s) => s.signal_name)).toEqual(["intent", "outcome"]);
    expect(JSON.parse(signals[0]!.value as string)).toBe("feature");
    expect(JSON.parse(signals[1]!.value as string)).toBe(
      "accomplished-cleanly",
    );
    expect(signals[0]!.run_id).toBe("run-1");

    const narratives = store.db
      .prepare("SELECT narrative_type, prose, anchors, run_id FROM narrative")
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(narratives.length).toBe(1);
    expect(narratives[0]!.narrative_type).toBe("assessment");
    expect(JSON.parse(narratives[0]!.anchors as string)).toEqual([
      { eventHash: "a".repeat(64) },
    ]);
  });
});

test("a re-judge supersedes the prior run's signals in place, no duplicates", () => {
  withStore((store) => {
    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      fullResult(),
    );

    const second = fullResult();
    const rejudged: JudgeResult = {
      ...second,
      signals: second.signals.map((s) =>
        s.signalName === "outcome"
          ? { ...s, value: "accomplished-with-correction" as const }
          : s,
      ),
    };
    writeAssessment(store, run("run-2", "2026-06-15T11:00:00.000Z"), rejudged);

    // Both run rows accumulate (provenance history is visible, ADR-0008).
    const runCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;
    expect(runCount).toBe(2);

    // The signal rows are superseded by the latest run, not duplicated.
    const signals = store.db
      .prepare(
        "SELECT signal_name, value, run_id FROM judged_signal ORDER BY signal_name",
      )
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(signals.length).toBe(2);
    expect(signals.every((s) => s.run_id === "run-2")).toBe(true);
    const outcome = signals.find((s) => s.signal_name === "outcome");
    expect(JSON.parse(outcome!.value as string)).toBe(
      "accomplished-with-correction",
    );
  });
});

test("the conversation-scope narrative supersede key enforces one row per key", () => {
  withStore((store) => {
    // The assessment narrative is conversation-scoped with an absent assignment
    // id (ADR-0008), stored under the empty-string sentinel. Its supersede key is
    // (session_id, scope, assignment_id, narrative_type). A NULL assignment_id PK
    // column does not enforce uniqueness in SQLite, so the writer's INSERT OR
    // REPLACE silently accumulates instead of superseding the conversation-scope
    // narrative; the empty-string sentinel keeps the key unique so the PK
    // supersede actually holds. Two same-key narratives in one run prove the key:
    // they carry the same run id, so the writer's prior-run delete sweep cannot
    // mask the duplicate, and only the PK supersede holds the row count at one.
    const base = fullResult();
    const conversationNarrative = {
      scope: "conversation" as const,
      narrativeType: "assessment",
      anchors: [{ eventHash: "a".repeat(64) }],
    };
    const twoSameKey: JudgeResult = {
      ...base,
      narratives: [
        { ...conversationNarrative, prose: "first take" },
        { ...conversationNarrative, prose: "second take" },
      ],
    };

    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      twoSameKey,
    );

    const narratives = store.db
      .prepare("SELECT prose FROM narrative")
      .all() as ReadonlyArray<Record<string, unknown>>;
    // Exactly one narrative row survives: the latest write of the key.
    expect(narratives.length).toBe(1);
    expect(narratives[0]!.prose).toBe("second take");
  });
});

test("a re-judge that drops a signal leaves no stale prior-run row", () => {
  withStore((store) => {
    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      fullResult(),
    );

    // The re-judge abstains on Outcome: only Intent is re-emitted.
    const dropped: JudgeResult = {
      ...fullResult(),
      complete: false,
      incompleteReason: "insufficient-evidence",
      signals: fullResult().signals.filter((s) => s.signalName === "intent"),
    };
    writeAssessment(store, run("run-2", "2026-06-15T11:00:00.000Z"), dropped);

    const signals = store.db
      .prepare("SELECT signal_name, run_id FROM judged_signal")
      .all() as ReadonlyArray<Record<string, unknown>>;
    // The stale Outcome from run-1 is gone; only run-2's Intent remains.
    expect(signals.length).toBe(1);
    expect(signals[0]!.signal_name).toBe("intent");
    expect(signals[0]!.run_id).toBe("run-2");
  });
});

test("reopening a store with migration v6 applied is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-judged-reopen-"));
  const path = join(dir, "feedback.db");
  try {
    const first = openStore(path);
    const initial = (
      first.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
        n: number;
      }
    ).n;
    first.close();

    const second = openStore(path);
    try {
      const after = (
        second.db
          .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
          .get() as { n: number }
      ).n;
      expect(after).toBe(initial);
      expect(after).toBeGreaterThanOrEqual(6);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
