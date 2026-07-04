/**
 * The judge_backend provenance dimension (judge-backends design decision 4). One
 * additive nullable column on assessment_run, stamped by the code path that
 * actually ran (never self-reported), written by the writer and projected by the
 * digest so a mixed-backend corpus is sliceable and honest. A pre-existing row
 * (no backend) reads as absent, meaning "before backends were recorded".
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
  const dir = mkdtempSync(join(tmpdir(), "regimen-judge-backend-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SESSION = "019e0000-1111-7000-8000-0000000bbbbb";
const ASSIGNMENT = "whole-conversation";

function run(runId: string): AssessmentRunIdentity {
  return {
    runId,
    sessionId: SESSION,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

function result(
  judgeBackend?: JudgeResult["provenance"]["judgeBackend"],
): JudgeResult {
  return {
    complete: true,
    provenance: {
      judgeModel: "claude-opus-4-8",
      rubricVersion: "2026-07-04.2",
      promptVersion: "2026-07-04.2",
      ...(judgeBackend === undefined ? {} : { judgeBackend }),
    },
    signals: [
      {
        scope: "conversation",
        signalName: "intent",
        valueKind: "categorical",
        value: "feature",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
    narratives: [],
  };
}

test("the digest projects the judge_backend the writer stamped", () => {
  withStore((store) => {
    writeAssessment(store, run("r1"), result("agent"));
    const digest = readJudgmentDigest(store.db, SESSION);
    expect(digest.judged).toBe(true);
    if (!digest.judged) return;
    expect(digest.provenance.judgeBackend).toBe("agent");
  });
});

test("a run written without a backend reads back with the backend absent", () => {
  withStore((store) => {
    writeAssessment(store, run("r1"), result());
    const digest = readJudgmentDigest(store.db, SESSION);
    expect(digest.judged).toBe(true);
    if (!digest.judged) return;
    expect(digest.provenance.judgeBackend).toBeUndefined();
  });
});
