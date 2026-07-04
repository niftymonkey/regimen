/**
 * The shared verdict pipeline: assembleVerdict, extracted from judge.ts so the
 * in-process Judge and the tier C agent recorder run the IDENTICAL body over one
 * raw verdict (spec section 1, judge-backends design decision 3). It hides JSON
 * extraction, the structural validity rule (prose before the Outcome label),
 * closed-vocabulary enforcement, enumerated-chunk-id anchor resolution and
 * membership, the on-shortfall attribution gate, and signal and narrative
 * assembly. It is pure: no store, no network, no clock.
 *
 * The taxonomy redesign lands new signals HERE, in one place, and both judging
 * paths inherit them, which is the deep-module payoff of the whole design.
 */
import type { AnchorRef, ContentChunk } from "../loader/reader-types.ts";
import type {
  AccomplishmentValue,
  AttributionValue,
  ConductingValue,
  ConventionAdherenceValue,
  CorrectionCostValue,
  EffortValue,
  EngagementValue,
  FramingValue,
  IntentValue,
  JudgedNarrative,
  JudgedSignal,
  SignalName,
  VerificationValue,
} from "./types.ts";

/**
 * The result of running the shared pipeline over one raw verdict. `ok:false`
 * carries a rejection reason for the caller to surface or repair on: the raw
 * text was not a JSON object, or a judgment label was given without the required
 * assessment prose. `ok:true` carries the assembled signals and narratives, and
 * an empty `signals` array is a valid grounded-but-empty result the caller
 * interprets (insufficient-evidence in the Judge, a rejection in the recorder).
 */
export type VerdictOutcome =
  | {
      readonly ok: true;
      readonly signals: JudgedSignal[];
      readonly narratives: JudgedNarrative[];
    }
  | { readonly ok: false; readonly reason: string };

/** The closed Intent vocabulary (ADR-0008). `other` is the escape. */
const INTENT_VALUES: ReadonlySet<string> = new Set<IntentValue>([
  "refactor",
  "bug-fix",
  "feature",
  "test-writing",
  "exploration",
  "schema-change",
  "other",
]);

/** The 3-value ordinal accomplishment vocabulary, low to high (ADR-0017). */
const ACCOMPLISHMENT_VALUES: ReadonlySet<string> = new Set<AccomplishmentValue>(
  ["not-accomplished", "partial", "accomplished"],
);

/** The 3-value ordinal correction-cost vocabulary, low to high (ADR-0017). */
const CORRECTION_COST_VALUES: ReadonlySet<string> =
  new Set<CorrectionCostValue>(["none", "light", "heavy"]);

/** The closed Engagement vocabulary (Decision 5 of the judge-prompt design). */
const ENGAGEMENT_VALUES: ReadonlySet<string> = new Set<EngagementValue>([
  "engaged",
  "not-engaged",
]);

/** The 3-value ordinal framing vocabulary, low to high (ADR-0017). */
const FRAMING_VALUES: ReadonlySet<string> = new Set<FramingValue>([
  "underspecified",
  "adequate",
  "clear",
]);

/** The 3-value ordinal conducting vocabulary, low to high (ADR-0017). */
const CONDUCTING_VALUES: ReadonlySet<string> = new Set<ConductingValue>([
  "poorly-conducted",
  "adequately-conducted",
  "well-conducted",
]);

/** The 3-value ordinal effort vocabulary, low to high (ADR-0017). */
const EFFORT_VALUES: ReadonlySet<string> = new Set<EffortValue>([
  "low",
  "moderate",
  "high",
]);

/** The closed Verification vocabulary (ADR-0017). */
const VERIFICATION_VALUES: ReadonlySet<string> = new Set<VerificationValue>([
  "verified",
  "accepted-unverified",
  "over-verified",
  "nothing-to-verify",
]);

/** The closed Attribution vocabulary, the on-shortfall routing targets (ADR-0017). */
const ATTRIBUTION_VALUES: ReadonlySet<string> = new Set<AttributionValue>([
  "framing",
  "conducting",
  "verification",
  "leverage",
  "ai",
  "environment",
]);

/** The closed convention-adherence vocabulary (ADR-0017). */
const CONVENTION_ADHERENCE_VALUES: ReadonlySet<string> =
  new Set<ConventionAdherenceValue>([
    "followed",
    "partially-followed",
    "violated",
  ]);

const WHOLE_CONVERSATION_ASSIGNMENT = "whole-conversation";

interface ParsedClaim {
  readonly value?: unknown;
  readonly prose?: unknown;
  readonly anchors?: unknown;
}

interface ParsedVerdict {
  readonly intent?: ParsedClaim;
  readonly accomplishment?: ParsedClaim;
  readonly "correction-cost"?: ParsedClaim;
  readonly assessment?: ParsedClaim;
  readonly engagement?: ParsedClaim;
  readonly framing?: ParsedClaim;
  readonly conducting?: ParsedClaim;
  readonly verification?: ParsedClaim;
  readonly effort?: ParsedClaim;
  readonly attribution?: ParsedClaim;
  readonly "convention-adherence"?: ParsedClaim;
}

/**
 * Run the shared pipeline over one raw verdict text and the conversation's
 * chunks. Rejects (ok:false) when the text is not a JSON object or when a
 * judgment label was given without the required assessment prose; otherwise
 * assembles the anchored signals and narratives (ok:true), with an empty signal
 * set left for the caller to interpret.
 */
export function assembleVerdict(
  rawText: string,
  chunks: ReadonlyArray<ContentChunk>,
): VerdictOutcome {
  const verdict = parseVerdict(rawText);
  const invalidity = validityError(verdict);
  if (invalidity !== undefined || verdict === undefined) {
    return {
      ok: false,
      reason: invalidity ?? "the response was not a JSON object",
    };
  }
  return {
    ok: true,
    signals: buildSignals(verdict, chunks),
    narratives: buildNarratives(verdict, chunks),
  };
}

/**
 * Parse the model's raw text into the loosely-typed verdict shape, tolerating
 * prose around the JSON object by extracting the outermost braces. Returns
 * undefined when no JSON object can be recovered.
 */
function parseVerdict(text: string): ParsedVerdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as ParsedVerdict)
    : undefined;
}

/**
 * Why a parsed verdict is structurally unusable, or undefined when it is valid
 * enough to assemble. The prose-before-label rule (ADR-0008, ADR-0017) is
 * enforced here for either co-equal Outcome axis: an accomplishment or a
 * correction-cost present with no assessment prose is invalid, so a done-ness or
 * steering label is never constructed without preceding reasoning.
 */
function validityError(verdict: ParsedVerdict | undefined): string | undefined {
  if (verdict === undefined) {
    return "the response was not a JSON object";
  }
  const hasJudgmentLabel =
    (verdict.accomplishment !== undefined &&
      verdict.accomplishment.value !== undefined) ||
    (verdict["correction-cost"] !== undefined &&
      verdict["correction-cost"].value !== undefined);
  const hasAssessment =
    verdict.assessment !== undefined &&
    typeof verdict.assessment.prose === "string";
  if (hasJudgmentLabel && !hasAssessment) {
    return "a judgment label was given without the required assessment prose, which must precede it";
  }
  return undefined;
}

/**
 * Resolve a claim's cited chunk ids to the real AnchorRefs of those chunks,
 * keeping only ids that map to a chunk in the set (the membership check). The
 * cited id is the chunk's lineSeq, which the prompt enumerated.
 */
function resolveAnchors(
  cited: unknown,
  chunkByLineSeq: ReadonlyMap<number, ContentChunk>,
): AnchorRef[] {
  if (!Array.isArray(cited)) return [];
  const anchors: AnchorRef[] = [];
  for (const id of cited) {
    if (typeof id !== "number") continue;
    const chunk = chunkByLineSeq.get(id);
    if (chunk !== undefined) anchors.push(chunk.anchor);
  }
  return anchors;
}

/**
 * Whether a verdict represents a shortfall (ADR-0017): the assignment fell short
 * of accomplished, or a live-arc quality signal sits at its poor floor. The
 * live-arc quality signals are `framing`, `conducting`, and `verification`; each
 * at its poor floor is a process-side shortfall even on an accomplished
 * assignment. `effort` and `convention-adherence` are not live-arc quality
 * signals, so a high `effort` or a `violated` convention is not a shortfall on
 * its own. Attribution, the on-shortfall diagnostic, is emitted only on a
 * shortfall so the store never persists a contradictory routing target.
 */
function isShortfall(verdict: ParsedVerdict): boolean {
  const accomplishment = verdict.accomplishment?.value;
  if (accomplishment === "partial" || accomplishment === "not-accomplished") {
    return true;
  }
  if (verdict.framing?.value === "underspecified") return true;
  if (verdict.conducting?.value === "poorly-conducted") return true;
  const verification = verdict.verification?.value;
  return (
    verification === "accepted-unverified" || verification === "over-verified"
  );
}

function buildSignals(
  verdict: ParsedVerdict,
  chunks: ReadonlyArray<ContentChunk>,
): JudgedSignal[] {
  const chunkByLineSeq = new Map(chunks.map((c) => [c.lineSeq, c]));
  const signals: JudgedSignal[] = [];

  if (
    verdict.intent !== undefined &&
    typeof verdict.intent.value === "string" &&
    INTENT_VALUES.has(verdict.intent.value)
  ) {
    const anchors = resolveAnchors(verdict.intent.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "intent",
        valueKind: "categorical",
        value: verdict.intent.value as IntentValue,
        anchors,
      });
    }
  }

  if (
    verdict.accomplishment !== undefined &&
    typeof verdict.accomplishment.value === "string" &&
    ACCOMPLISHMENT_VALUES.has(verdict.accomplishment.value)
  ) {
    const anchors = resolveAnchors(
      verdict.accomplishment.anchors,
      chunkByLineSeq,
    );
    if (anchors.length > 0) {
      signals.push({
        scope: "assignment",
        assignmentId: WHOLE_CONVERSATION_ASSIGNMENT,
        signalName: "accomplishment",
        valueKind: "ordinal",
        value: verdict.accomplishment.value as AccomplishmentValue,
        anchors,
      });
    }
  }

  const correctionCost = verdict["correction-cost"];
  if (
    correctionCost !== undefined &&
    typeof correctionCost.value === "string" &&
    CORRECTION_COST_VALUES.has(correctionCost.value)
  ) {
    const anchors = resolveAnchors(correctionCost.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "assignment",
        assignmentId: WHOLE_CONVERSATION_ASSIGNMENT,
        signalName: "correction-cost",
        valueKind: "ordinal",
        value: correctionCost.value as CorrectionCostValue,
        anchors,
      });
    }
  }

  if (
    verdict.engagement !== undefined &&
    typeof verdict.engagement.value === "string" &&
    ENGAGEMENT_VALUES.has(verdict.engagement.value)
  ) {
    const anchors = resolveAnchors(verdict.engagement.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "engagement",
        valueKind: "categorical",
        value: verdict.engagement.value as EngagementValue,
        anchors,
      });
    }
  }

  if (
    verdict.framing !== undefined &&
    typeof verdict.framing.value === "string" &&
    FRAMING_VALUES.has(verdict.framing.value)
  ) {
    const anchors = resolveAnchors(verdict.framing.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "framing",
        valueKind: "ordinal",
        value: verdict.framing.value as FramingValue,
        anchors,
      });
    }
  }

  if (
    verdict.conducting !== undefined &&
    typeof verdict.conducting.value === "string" &&
    CONDUCTING_VALUES.has(verdict.conducting.value)
  ) {
    const anchors = resolveAnchors(verdict.conducting.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "conducting",
        valueKind: "ordinal",
        value: verdict.conducting.value as ConductingValue,
        anchors,
      });
    }
  }

  if (
    verdict.verification !== undefined &&
    typeof verdict.verification.value === "string" &&
    VERIFICATION_VALUES.has(verdict.verification.value)
  ) {
    const anchors = resolveAnchors(
      verdict.verification.anchors,
      chunkByLineSeq,
    );
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "verification",
        valueKind: "categorical",
        value: verdict.verification.value as VerificationValue,
        anchors,
      });
    }
  }

  if (
    verdict.effort !== undefined &&
    typeof verdict.effort.value === "string" &&
    EFFORT_VALUES.has(verdict.effort.value)
  ) {
    const anchors = resolveAnchors(verdict.effort.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "effort",
        valueKind: "ordinal",
        value: verdict.effort.value as EffortValue,
        anchors,
      });
    }
  }

  if (
    isShortfall(verdict) &&
    verdict.attribution !== undefined &&
    typeof verdict.attribution.value === "string" &&
    ATTRIBUTION_VALUES.has(verdict.attribution.value)
  ) {
    const anchors = resolveAnchors(verdict.attribution.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "attribution",
        valueKind: "categorical",
        value: verdict.attribution.value as AttributionValue,
        anchors,
      });
    }
  }

  const conventionAdherence = verdict["convention-adherence"];
  if (
    conventionAdherence !== undefined &&
    typeof conventionAdherence.value === "string" &&
    CONVENTION_ADHERENCE_VALUES.has(conventionAdherence.value)
  ) {
    const anchors = resolveAnchors(conventionAdherence.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "conversation",
        signalName: "convention-adherence",
        valueKind: "categorical",
        value: conventionAdherence.value as ConventionAdherenceValue,
        anchors,
      });
    }
  }

  return signals;
}

function buildNarratives(
  verdict: ParsedVerdict,
  chunks: ReadonlyArray<ContentChunk>,
): JudgedNarrative[] {
  const chunkByLineSeq = new Map(chunks.map((c) => [c.lineSeq, c]));
  if (
    verdict.assessment === undefined ||
    typeof verdict.assessment.prose !== "string"
  ) {
    return [];
  }
  const anchors = resolveAnchors(verdict.assessment.anchors, chunkByLineSeq);
  if (anchors.length === 0) return [];
  return [
    {
      scope: "conversation",
      narrativeType: "assessment",
      prose: verdict.assessment.prose,
      anchors,
    },
  ];
}

/** The closed vocabulary for each judge-emitted signal, single-sourced here so a
 * health check reads the same sets the assembler enforces. `outcome` is absent:
 * it is write-derived, never emitted by the judge. */
const VOCAB_BY_SIGNAL: ReadonlyMap<SignalName, ReadonlySet<string>> = new Map<
  SignalName,
  ReadonlySet<string>
>([
  ["intent", INTENT_VALUES],
  ["accomplishment", ACCOMPLISHMENT_VALUES],
  ["correction-cost", CORRECTION_COST_VALUES],
  ["engagement", ENGAGEMENT_VALUES],
  ["framing", FRAMING_VALUES],
  ["conducting", CONDUCTING_VALUES],
  ["verification", VERIFICATION_VALUES],
  ["effort", EFFORT_VALUES],
  ["attribution", ATTRIBUTION_VALUES],
  ["convention-adherence", CONVENTION_ADHERENCE_VALUES],
]);

/** A structural-gate rule a raw verdict can violate (health mode). */
export type GateViolation =
  | "attribution-without-shortfall"
  | "correction-cost-without-accomplished"
  | "engagement-missing";

/**
 * One emitted signal's elicitation health: its raw value, whether that value is
 * in the closed vocabulary, and whether at least one cited anchor resolved to a
 * chunk in the conversation (the same membership rule the assembler enforces).
 */
export interface SignalDiagnostic {
  readonly signalName: SignalName;
  readonly value: string;
  readonly inVocabulary: boolean;
  readonly anchorsResolved: boolean;
}

/**
 * The rubric-regression diagnostics for one raw verdict, the health-mode twin of
 * assembleVerdict. It reports whether the text parsed, a per-emitted-signal
 * vocabulary and anchor-resolution health, and the structural-gate violations
 * (attribution off a shortfall, correction-cost off an accomplished verdict,
 * engagement missing entirely). Pure: no store, no clock. It reads the RAW
 * verdict so it can see an out-of-vocabulary value the assembler would silently
 * drop, which is exactly the elicitation regression the health gate must catch.
 */
export function diagnoseVerdict(
  rawText: string,
  chunks: ReadonlyArray<ContentChunk>,
): {
  parsed: boolean;
  signals: SignalDiagnostic[];
  gateViolations: GateViolation[];
} {
  const verdict = parseVerdict(rawText);
  if (verdict === undefined) {
    return { parsed: false, signals: [], gateViolations: [] };
  }
  const chunkByLineSeq = new Map(chunks.map((c) => [c.lineSeq, c]));
  const signals: SignalDiagnostic[] = [];
  for (const [signalName, vocab] of VOCAB_BY_SIGNAL) {
    const claim = (verdict as Record<string, ParsedClaim | undefined>)[
      signalName
    ];
    if (claim === undefined || typeof claim.value !== "string") continue;
    signals.push({
      signalName,
      value: claim.value,
      inVocabulary: vocab.has(claim.value),
      anchorsResolved: resolveAnchors(claim.anchors, chunkByLineSeq).length > 0,
    });
  }

  const gateViolations: GateViolation[] = [];
  const attribution = verdict.attribution;
  if (
    attribution !== undefined &&
    typeof attribution.value === "string" &&
    !isShortfall(verdict)
  ) {
    gateViolations.push("attribution-without-shortfall");
  }
  const correctionCost = verdict["correction-cost"];
  if (
    correctionCost !== undefined &&
    typeof correctionCost.value === "string" &&
    verdict.accomplishment?.value !== "accomplished"
  ) {
    gateViolations.push("correction-cost-without-accomplished");
  }
  if (
    verdict.engagement === undefined ||
    typeof verdict.engagement.value !== "string"
  ) {
    gateViolations.push("engagement-missing");
  }
  return { parsed: true, signals, gateViolations };
}
