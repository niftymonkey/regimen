/**
 * The judged-layer wire types (ADR-0008), shared by the Judge (which produces
 * a JudgeResult), the writer (which maps it onto the four tables), and the
 * reader (which projects the rows back into a JudgmentDigest).
 *
 * These mirror the ADR-0008 output contract one-to-one: a JudgeResult is the
 * pure shape the orchestrator writes, carrying provenance, the run's complete
 * flag, the judged signals (Intent and Outcome today), and the narratives (the
 * conversation assessment today). AnchorRef and ContentChunk come from the S2
 * reader unchanged so the judged layer introduces no new id space.
 */
import type { AnchorRef } from "../loader/reader-types.ts";
import type { DerivedOutcomeValue } from "./outcome.ts";

/**
 * The closed controlled vocabulary of signal names (ADR-0008, amended by
 * ADR-0017). It grows by adding a member; a new signal is a new member plus its
 * prompt fragment and parser, never an interface change. `outcome` is no longer a
 * judge-emitted primitive: it is the write-derived read-key the writer stores
 * from the two axes `accomplishment` and `correction-cost`.
 */
export type SignalName =
  | "intent"
  | "accomplishment"
  | "correction-cost"
  | "outcome"
  | "engagement";

/**
 * The open value-kind tag (ADR-0008). `categorical` and `ordinal` are the live
 * kinds; further kinds arrive with the signals that need them.
 */
export type ValueKind = "categorical" | "ordinal";

/** Intent: one value naming what the engineer was trying to do (categorical). */
export type IntentValue =
  | "refactor"
  | "bug-fix"
  | "feature"
  | "test-writing"
  | "exploration"
  | "schema-change"
  | "other";

/**
 * Accomplishment: done-ness only, rank-ordered low to high (ADR-0017). Owns
 * whether the assignment's stated intent was reached, cause-free.
 */
export type AccomplishmentValue =
  | "not-accomplished"
  | "partial"
  | "accomplished";

/**
 * Correction-cost: how much the engineer redirected, corrected, or repaired the
 * AI's course, rank-ordered low to high (ADR-0017). Emitted only when the
 * assignment was accomplished; abstains otherwise (the floor absorbs steering).
 */
export type CorrectionCostValue = "none" | "light" | "heavy";

/**
 * Engagement: one value naming whether the conversation genuinely became a work
 * session on the assignment (categorical, conversation-scoped). It is orthogonal
 * to Outcome and separates the AI falling short on real work from a session that
 * was never a real work session.
 */
export type EngagementValue = "engaged" | "not-engaged";

/** Why a run did not finish clean. Absent on a complete run. */
export type IncompleteReason =
  | "insufficient-evidence"
  | "llm-unparseable"
  | "llm-unavailable";

/** The scope of a judged signal or narrative. */
export type JudgedScope = "conversation" | "assignment";

/**
 * Provenance stamped on every assessment_run, including an incomplete one, so a
 * re-judge after a rubric or prompt change is detectable. `judgeModel` is
 * opaque: nothing downstream may branch on its contents (ADR-0008).
 */
export interface JudgeProvenance {
  readonly judgeModel: string;
  readonly rubricVersion: string;
  readonly promptVersion: string;
}

/**
 * One judged signal, mapping onto one judged_signal row. An absent signal is an
 * abstention, never a fabricated value (ADR-0008). `value` is the typed value
 * the orchestrator JSON-encodes into the row's `value` column.
 */
export interface JudgedSignal {
  readonly scope: JudgedScope;
  /**
   * The assignment this signal is scoped to, or absent for a conversation-scope
   * signal. Absence is the domain truth (ADR-0008's nullable assignment_id); the
   * writer maps an absent id onto the stored empty-string sentinel so the PK
   * column stays non-null and supersede keys remain unique.
   */
  readonly assignmentId?: string;
  readonly signalName: SignalName;
  readonly valueKind: ValueKind;
  readonly value:
    | IntentValue
    | AccomplishmentValue
    | CorrectionCostValue
    | DerivedOutcomeValue
    | EngagementValue;
  readonly anchors: ReadonlyArray<AnchorRef>;
}

/**
 * One judged narrative, mapping onto one narrative row. The assess spine writes
 * exactly one, the scope=conversation `assessment`, generated before the
 * Outcome label so reasoning precedes the label (ADR-0008).
 */
export interface JudgedNarrative {
  readonly scope: JudgedScope;
  /**
   * The assignment this narrative is scoped to, or absent for the
   * conversation-scope assessment (ADR-0008's nullable assignment_id). The
   * writer maps an absent id onto the stored empty-string sentinel.
   */
  readonly assignmentId?: string;
  readonly narrativeType: string;
  readonly prose: string;
  readonly anchors: ReadonlyArray<AnchorRef>;
}

/**
 * The pure result of one judgment pass over one conversation. The orchestrator
 * maps it onto the four ADR-0008 tables mechanically; the Judge writes no
 * SQLite. A degraded pass still resolves to a JudgeResult (complete=false with
 * an incompleteReason and the unsupportable signals absent), never a throw.
 */
export interface JudgeResult {
  readonly complete: boolean;
  readonly provenance: JudgeProvenance;
  readonly signals: ReadonlyArray<JudgedSignal>;
  readonly narratives: ReadonlyArray<JudgedNarrative>;
  readonly incompleteReason?: IncompleteReason;
}
