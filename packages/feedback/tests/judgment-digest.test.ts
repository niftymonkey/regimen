/**
 * JudgmentDigest read behavior (S3, ADR-0008), observed through
 * readJudgmentDigest. Each test seeds a store with the writer, then asserts on
 * the digest the reader returns. The clock is injected so generatedAt is
 * deterministic. The reader is pure SQLite: no Judge, no network, like
 * readEvidenceDigest.
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
import { readJudgmentDigest } from "../src/judged/digest.ts";
import type { JudgeResult } from "../src/judged/types.ts";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-jdigest-"));
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
const FIXED = () => Date.parse("2026-06-15T12:00:00.000Z");

function run(runId: string, createdAt: string): AssessmentRunIdentity {
  return { runId, sessionId: SESSION, assignmentId: ASSIGNMENT, createdAt };
}

function fullResult(complete = true): JudgeResult {
  return {
    complete,
    provenance: {
      judgeModel: "claude-opus-4-8",
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
        assignmentId: ASSIGNMENT,
        narrativeType: "assessment",
        prose: "The agent built the feature with light steering.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

test("a session with no assessment run reads the unjudged branch", () => {
  withStore((store) => {
    const digest = readJudgmentDigest(store.db, SESSION, FIXED);
    expect(digest.judged).toBe(false);
    expect(digest.sessionId).toBe(SESSION);
    expect(digest.generatedAt).toBe("2026-06-15T12:00:00.000Z");
    if (digest.judged === false) {
      expect(typeof digest.note).toBe("string");
      expect(digest.note.length).toBeGreaterThan(0);
    }
  });
});

test("a complete run reads the judged branch led by the assessment and the lone Outcome", () => {
  withStore((store) => {
    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      fullResult(),
    );
    const digest = readJudgmentDigest(store.db, SESSION, FIXED);
    expect(digest.judged).toBe(true);
    if (digest.judged !== true) return;

    // The headline: the conversation assessment leads, with the lone Outcome
    // sitting directly beneath it (ADR-0008's headline-led read).
    expect(digest.assessment).not.toBeNull();
    expect(digest.assessment!.prose).toBe(
      "The agent built the feature with light steering.",
    );
    expect(digest.assessment!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
    expect(digest.outcome).not.toBeNull();
    expect(digest.outcome!.value).toBe("accomplished-cleanly");

    // Provenance is projected (judge_model is opaque, never branched on).
    expect(digest.complete).toBe(true);
    expect(digest.provenance.judgeModel).toBe("claude-opus-4-8");
    expect(digest.provenance.rubricVersion).toBe("2026-06-15");
    expect(digest.provenance.promptVersion).toBe("2026-06-15");

    // The assignment and its signals are the drill-down beneath the headline.
    expect(digest.assignment.assignmentId).toBe(ASSIGNMENT);
    const names = digest.assignment.signals.map((s) => s.signalName).sort();
    expect(names).toEqual(["intent", "outcome"]);
    const intent = digest.assignment.signals.find(
      (s) => s.signalName === "intent",
    );
    expect(intent!.value).toBe("feature");
    expect(intent!.valueKind).toBe("categorical");
    expect(intent!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
  });
});

test("an incomplete run still renders the judged branch carrying complete=false", () => {
  withStore((store) => {
    const incomplete: JudgeResult = {
      ...fullResult(false),
      incompleteReason: "insufficient-evidence",
      // The unsupportable Outcome abstains; Intent and the assessment stand.
      signals: fullResult().signals.filter((s) => s.signalName === "intent"),
    };
    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      incomplete,
    );
    const digest = readJudgmentDigest(store.db, SESSION, FIXED);
    expect(digest.judged).toBe(true);
    if (digest.judged !== true) return;
    expect(digest.complete).toBe(false);
    // The abstained Outcome renders as absent (null), never a default zero.
    expect(digest.outcome).toBeNull();
    expect(digest.assignment.signals.map((s) => s.signalName)).toEqual([
      "intent",
    ]);
  });
});

test("the digest reflects only the latest run after a re-judge", () => {
  withStore((store) => {
    writeAssessment(
      store,
      run("run-1", "2026-06-15T10:00:00.000Z"),
      fullResult(),
    );
    const rejudged: JudgeResult = {
      ...fullResult(),
      signals: fullResult().signals.map((s) =>
        s.signalName === "outcome" ? { ...s, value: "partial" as const } : s,
      ),
    };
    writeAssessment(store, run("run-2", "2026-06-15T11:00:00.000Z"), rejudged);
    const digest = readJudgmentDigest(store.db, SESSION, FIXED);
    if (digest.judged !== true) throw new Error("expected judged");
    expect(digest.outcome!.value).toBe("partial");
  });
});
