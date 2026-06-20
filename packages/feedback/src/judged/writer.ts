/**
 * The judged-store writer (S3, ADR-0008).
 *
 * Maps one JudgeResult onto the four ADR-0008 tables in a single transaction:
 * one assessment_run, one whole-conversation assignment, the judged_signal
 * rows (Intent and Outcome when present), and one assessment narrative. The
 * write supersedes any prior run for the session by run identity (section 7):
 * re-emitted signals and narratives replace by their supersede-key PK, and any
 * prior-run row the new run did not re-emit is deleted, so a re-judge that
 * drops a signal leaves no stale row and a reader never sees a mix of two runs.
 *
 * A conversation-scope row has an absent assignmentId (ADR-0008's nullable
 * assignment_id); the writer maps that absence onto the stored empty-string
 * sentinel so the supersede-key PK column stays non-null. A NULL PK column does
 * not enforce uniqueness in SQLite, so the empty-string sentinel is what makes
 * the conversation-scope narrative and signal supersede by PK rather than
 * silently accumulate a duplicate.
 */
import type { Store } from "../store.ts";
import type { JudgeResult } from "./types.ts";

/** The run identity the orchestrator mints for one judgment pass. */
export interface AssessmentRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly createdAt: string;
}

/**
 * Write one judgment pass's verdict, superseding any prior run for the session
 * atomically. The signal `value` is JSON-encoded by its `value_kind`; the
 * narrative `anchors` are JSON-encoded as an AnchorRef[].
 */
export function writeAssessment(
  store: Store,
  run: AssessmentRunIdentity,
  result: JudgeResult,
): void {
  const db = store.db;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO assessment_run
         (run_id, session_id, rubric_version, prompt_version, judge_model, complete, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.runId,
      run.sessionId,
      result.provenance.rubricVersion,
      result.provenance.promptVersion,
      result.provenance.judgeModel,
      result.complete ? 1 : 0,
      run.createdAt,
    );

    db.prepare(
      `INSERT OR IGNORE INTO assignment (session_id, assignment_id) VALUES (?, ?)`,
    ).run(run.sessionId, run.assignmentId);

    const insertSignal = db.prepare(
      `INSERT OR REPLACE INTO judged_signal
         (session_id, scope, assignment_id, signal_name, value_kind, value, anchors, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const signal of result.signals) {
      insertSignal.run(
        run.sessionId,
        signal.scope,
        signal.assignmentId ?? "",
        signal.signalName,
        signal.valueKind,
        JSON.stringify(signal.value),
        JSON.stringify(signal.anchors),
        run.runId,
      );
    }

    const insertNarrative = db.prepare(
      `INSERT OR REPLACE INTO narrative
         (session_id, scope, assignment_id, narrative_type, prose, anchors, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const narrative of result.narratives) {
      insertNarrative.run(
        run.sessionId,
        narrative.scope,
        narrative.assignmentId ?? "",
        narrative.narrativeType,
        narrative.prose,
        JSON.stringify(narrative.anchors),
        run.runId,
      );
    }

    // Delete any prior-run signal or narrative the new run did not re-emit, so
    // a re-judge that drops a signal leaves no stale row (section 7). Re-emitted
    // rows already carry the new run_id from the INSERT OR REPLACE above; the
    // surviving rows of an older run are exactly those this run did not touch.
    db.prepare(
      `DELETE FROM judged_signal WHERE session_id = ? AND run_id != ?`,
    ).run(run.sessionId, run.runId);
    db.prepare(
      `DELETE FROM narrative WHERE session_id = ? AND run_id != ?`,
    ).run(run.sessionId, run.runId);
  })();
}
