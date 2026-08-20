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
      /**
       * The field keys the model gave a usable value or prose to but whose every
       * cited chunk id missed the conversation, so the field assembled to zero
       * anchors (a dropped signal, or an under-anchored assessment narrative).
       * `assessment` leads when present. Empty on a fully-anchored verdict. The
       * Judge reads this to fire one repair-retry that tells the model to cite
       * only real ids; it never changes what assembles, so a caller that ignores
       * it sees the identical signals and narratives.
       */
      readonly underAnchored: string[];
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
  const chunkByLineSeq = new Map(chunks.map((c) => [c.lineSeq, c]));
  return {
    ok: true,
    signals: buildSignals(verdict, chunkByLineSeq),
    narratives: buildNarratives(verdict, chunkByLineSeq),
    underAnchored: underAnchoredFields(verdict, chunkByLineSeq),
  };
}

/**
 * The field keys the model valued (a usable signal value in vocabulary, or
 * assessment prose) but whose every cited id missed the conversation, so the
 * field resolved to zero anchors. `assessment` leads when present so the Judge
 * can prioritise recovering the prose's grounding. Attribution off a shortfall
 * is excluded: it is dropped regardless of anchors, so re-citing cannot recover
 * it. Pure; it re-walks the parsed verdict without mutating the assembly.
 */
function underAnchoredFields(
  verdict: ParsedVerdict,
  chunkByLineSeq: ReadonlyMap<number, ContentChunk>,
): string[] {
  const fields: string[] = [];
  if (
    verdict.assessment !== undefined &&
    typeof verdict.assessment.prose === "string" &&
    resolveAnchors(verdict.assessment.anchors, chunkByLineSeq).length === 0
  ) {
    fields.push("assessment");
  }
  for (const [signalName, vocab] of VOCAB_BY_SIGNAL) {
    const claim = (verdict as Record<string, ParsedClaim | undefined>)[
      signalName
    ];
    if (
      claim === undefined ||
      typeof claim.value !== "string" ||
      !vocab.has(claim.value)
    ) {
      continue;
    }
    if (signalName === "attribution" && !isShortfall(verdict)) continue;
    if (resolveAnchors(claim.anchors, chunkByLineSeq).length === 0) {
      fields.push(signalName);
    }
  }
  return fields;
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
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return withoutNullFields(parsed as Record<string, unknown>);
}

/**
 * Drop every field the model emitted as an explicit `null`. A model with
 * nothing to say for a field may omit it or write `null`, and both mean absent.
 * Normalizing here is what makes `ParsedClaim | undefined` an honest shape:
 * without it, every `!== undefined` guard downstream passes on a `null` and
 * then dereferences it, which is how one sweep died on `correction-cost`.
 */
function withoutNullFields(parsed: Record<string, unknown>): ParsedVerdict {
  // fromEntries, not assignment: `kept["__proto__"] = value` runs the setter
  // and makes a model-emitted `__proto__` the prototype of the result, so its
  // null claims read back through the chain and crash exactly as above.
  const kept = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== null),
  );
  return kept as ParsedVerdict;
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
 * How far a near-miss cited id may sit from the closest real chunk id and still
 * snap to it. Chunk ids are the contiguous lineSeq the prompt enumerated, so a
 * miss is almost always an off-by-a-little past a boundary (a model citing one or
 * two past the last id, or a 1-based slip). Two is deliberately small: it forgives
 * the common weak-model slip without letting a wildly wrong id borrow a chunk's
 * authority. An in-range id always matches exactly, so snapping only ever fires
 * on an id outside the real set.
 */
const ANCHOR_SNAP_WINDOW = 2;

/**
 * The widest hyphenated range (e.g. "3-9") the resolver will expand. A range this
 * wide is far more likely to be junk than a real citation, so it is dropped rather
 * than iterated; genuine spans are bounded by the transcript's chunk count anyway.
 */
const MAX_RANGE_WIDTH = 1024;

/**
 * Resolve a claim's cited chunk ids to the real AnchorRefs of those chunks,
 * forgiving the miscitation shapes a weak or non-Claude judge model emits so a
 * sloppy citation degrades to fewer anchors rather than discarding the field.
 * The cited id is the chunk's lineSeq, which the prompt enumerated. Accepted
 * shapes, all filtered by membership: a number; a numeric string ("3", observed
 * from a Claude model through the OpenAI-compat endpoint); a hyphenated range
 * ("1-3") expanded to the ids it spans; a bare (non-array) value treated as a
 * single citation. An id with no exact chunk snaps to the nearest real id within
 * {@link ANCHOR_SNAP_WINDOW}; anything further, and any non-id junk, is ignored.
 * Anchors are deduplicated by chunk so overlapping citations do not double-count.
 */
function resolveAnchors(
  cited: unknown,
  chunkByLineSeq: ReadonlyMap<number, ContentChunk>,
): AnchorRef[] {
  const tokens = Array.isArray(cited)
    ? cited
    : cited === undefined || cited === null
      ? []
      : [cited];
  const sortedIds = [...chunkByLineSeq.keys()].sort((a, b) => a - b);
  const anchors: AnchorRef[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    for (const candidate of candidateIds(token)) {
      const lineSeq = snapToChunk(candidate, chunkByLineSeq, sortedIds);
      if (lineSeq === undefined || seen.has(lineSeq)) continue;
      seen.add(lineSeq);
      anchors.push(chunkByLineSeq.get(lineSeq)!.anchor);
    }
  }
  return anchors;
}

/**
 * Expand one cited token into the candidate chunk ids it names, before the
 * membership and snap checks: a whole non-negative number or numeric string is
 * itself; a hyphenated range ("1-3", or reversed "3-1") is every id it spans, up
 * to {@link MAX_RANGE_WIDTH}; anything else is junk and yields none.
 */
function candidateIds(token: unknown): number[] {
  if (typeof token === "number") {
    return Number.isInteger(token) && token >= 0 ? [token] : [];
  }
  if (typeof token !== "string") return [];
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) return [Number(trimmed)];
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (range === null) return [];
  const lo = Math.min(Number(range[1]), Number(range[2]));
  const hi = Math.max(Number(range[1]), Number(range[2]));
  if (hi - lo > MAX_RANGE_WIDTH) return [];
  const ids: number[] = [];
  for (let id = lo; id <= hi; id += 1) ids.push(id);
  return ids;
}

/**
 * The real chunk id a candidate resolves to: itself on an exact match, otherwise
 * the nearest real id within {@link ANCHOR_SNAP_WINDOW} (ties break to the lower
 * id, `sortedIds` being ascending), or undefined when nothing is close enough.
 */
function snapToChunk(
  candidate: number,
  chunkByLineSeq: ReadonlyMap<number, ContentChunk>,
  sortedIds: ReadonlyArray<number>,
): number | undefined {
  if (chunkByLineSeq.has(candidate)) return candidate;
  let best: number | undefined;
  let bestDistance = Infinity;
  for (const id of sortedIds) {
    const distance = Math.abs(id - candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  }
  return best !== undefined && bestDistance <= ANCHOR_SNAP_WINDOW
    ? best
    : undefined;
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
  chunkByLineSeq: ReadonlyMap<number, ContentChunk>,
): JudgedSignal[] {
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
  chunkByLineSeq: ReadonlyMap<number, ContentChunk>,
): JudgedNarrative[] {
  if (
    verdict.assessment === undefined ||
    typeof verdict.assessment.prose !== "string"
  ) {
    return [];
  }
  const anchors = resolveAnchors(verdict.assessment.anchors, chunkByLineSeq);
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
