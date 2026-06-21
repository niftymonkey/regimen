/**
 * The judged-layer read side: readJudgmentDigest, the judged twin of
 * readEvidenceDigest (S3, ADR-0008).
 *
 * A discriminated union on a `judged` boolean. The unjudged branch is a
 * genuinely different shape with its own constructor (never the judged shape
 * with empty placeholders); the judged branch leads with the conversation
 * assessment and the lone Outcome beneath it, with the assignment and its
 * signals as the drill-down. Pure SQLite read: no Judge, no network, no writes.
 */
import type { Database } from "bun:sqlite";
import type { AnchorRef } from "../loader/reader-types.ts";
import { sessionHarnessModel } from "./slice.ts";
import type { JudgeProvenance, SignalName, ValueKind } from "./types.ts";

export type JudgmentDigest = UnjudgedDigest | JudgedDigest;

/**
 * The unjudged branch: Feedback off, no run yet, or the transcript gone. A
 * genuinely different shape, never the judged shape with empty placeholders.
 */
export interface UnjudgedDigest {
  schemaVersion: 1;
  generatedAt: string;
  sessionId: string;
  judged: false;
  note: string;
}

/** A signal projected from a judged_signal row, with its value JSON-decoded. */
export interface DigestSignal {
  signalName: SignalName;
  valueKind: ValueKind;
  value: string;
  anchors: ReadonlyArray<AnchorRef>;
}

/** The headline assessment narrative and its anchors. */
export interface DigestAssessment {
  prose: string;
  anchors: ReadonlyArray<AnchorRef>;
}

/** The lone whole-conversation Outcome sitting beneath the assessment. */
export interface DigestOutcome {
  value: string;
  anchors: ReadonlyArray<AnchorRef>;
}

/** The assignment drill-down: its id and every signal scoped to it. */
export interface DigestAssignment {
  assignmentId: string;
  signals: ReadonlyArray<DigestSignal>;
}

/**
 * The judged branch, headline-led: the conversation assessment, the lone
 * Outcome beneath it, then the assignment and its signals as the drill-down.
 * `complete=false` still renders here so the surface is honest about a run that
 * did not finish clean. `provenance.judgeModel` is opaque; it is projected,
 * never branched on.
 */
export interface JudgedDigest {
  schemaVersion: 1;
  generatedAt: string;
  sessionId: string;
  judged: true;
  /**
   * The harness that produced the conversation, recovered at read time by
   * joining `conversations` (ADR-0008's read-time slice). Never stored on a
   * judged row; an opaque string flowing from the `conversations.harness`
   * column.
   */
  harness: string;
  /**
   * The model the conversation ran, recovered by the same read-time join.
   * Nullable: `conversations.model` is nullable, and a null surfaces as null
   * rather than a crash or a fabricated value.
   */
  model: string | null;
  complete: boolean;
  provenance: JudgeProvenance;
  /** The conversation assessment; null when the run abstained on it. */
  assessment: DigestAssessment | null;
  /** The lone whole-conversation Outcome; null when the run abstained on it. */
  outcome: DigestOutcome | null;
  assignment: DigestAssignment;
}

/**
 * Build the unjudged-branch digest for a session with no run. Its own
 * constructor, mirroring evidence's unknownDigest: a genuinely different shape,
 * never the judged shape with empty placeholders (ADR-0008). Covers Feedback
 * off, no run yet, or the transcript gone.
 */
export function unjudgedDigest(
  sessionId: string,
  now: () => number = Date.now,
  note = "no assessment run recorded for this session yet",
): UnjudgedDigest {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    sessionId,
    judged: false,
    note,
  };
}

interface RunRow {
  run_id: string;
  rubric_version: string;
  prompt_version: string;
  judge_model: string;
  complete: number;
}

interface JudgedSignalRow {
  signal_name: string;
  value_kind: string;
  value: string;
  anchors: string;
}

interface NarrativeRow {
  prose: string;
  anchors: string;
}

/** Decode an AnchorRef[] from a row's JSON `anchors` column. */
function decodeAnchors(json: string): ReadonlyArray<AnchorRef> {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as ReadonlyArray<AnchorRef>) : [];
}

/**
 * Read the judged layer for one conversation and shape it into a digest. Pure
 * SQLite read: no Judge, no network, no writes. A session with no assessment
 * run yields the unjudged branch; `now` is injectable so generatedAt is
 * deterministic in tests. The verdict is the rows whose run_id is the latest
 * run for the session, which is what the supersede write already leaves.
 */
export function readJudgmentDigest(
  db: Database,
  sessionId: string,
  now: () => number = Date.now,
): JudgmentDigest {
  const latest = db
    .prepare(
      `SELECT run_id, rubric_version, prompt_version, judge_model, complete
         FROM assessment_run WHERE session_id = ?
         ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    )
    .get(sessionId) as RunRow | null;
  if (!latest) return unjudgedDigest(sessionId, now);

  const assignmentId =
    (
      db
        .prepare(
          `SELECT assignment_id FROM assignment WHERE session_id = ?
             ORDER BY assignment_id ASC LIMIT 1`,
        )
        .get(sessionId) as { assignment_id: string } | null
    )?.assignment_id ?? "";

  const signals: DigestSignal[] = (
    db
      .prepare(
        `SELECT signal_name, value_kind, value, anchors FROM judged_signal
           WHERE session_id = ?
           ORDER BY signal_name ASC`,
      )
      .all(sessionId) as JudgedSignalRow[]
  ).map((row) => ({
    signalName: row.signal_name as DigestSignal["signalName"],
    valueKind: row.value_kind as DigestSignal["valueKind"],
    value: JSON.parse(row.value) as string,
    anchors: decodeAnchors(row.anchors),
  }));

  const narrative = db
    .prepare(
      `SELECT prose, anchors FROM narrative
         WHERE session_id = ? AND scope = 'conversation' AND narrative_type = 'assessment'
         LIMIT 1`,
    )
    .get(sessionId) as NarrativeRow | null;
  const assessment: DigestAssessment | null = narrative
    ? { prose: narrative.prose, anchors: decodeAnchors(narrative.anchors) }
    : null;

  const outcomeSignal = signals.find((s) => s.signalName === "outcome");
  const outcome: DigestOutcome | null = outcomeSignal
    ? { value: outcomeSignal.value, anchors: outcomeSignal.anchors }
    : null;

  const slice = sessionHarnessModel(db, sessionId);

  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    sessionId,
    judged: true,
    harness: slice?.harness ?? "",
    model: slice?.model ?? null,
    complete: latest.complete === 1,
    provenance: {
      judgeModel: latest.judge_model,
      rubricVersion: latest.rubric_version,
      promptVersion: latest.prompt_version,
    },
    assessment,
    outcome,
    assignment: { assignmentId, signals },
  };
}
