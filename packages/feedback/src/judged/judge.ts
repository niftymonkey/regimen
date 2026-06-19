/**
 * The Judge: judgeConversation, the one deep new module of S3 (spec section 2).
 *
 * A narrow interface over a body that hides prompt construction (grounded in
 * docs/feedback-surfacing.md), the LLM round-trip behind the JudgeModelPort
 * seam, output parsing, closed-vocabulary enforcement, enumerated-chunk-id
 * anchor citation with membership validation, bounded retry, and fail-closed
 * assembly. It returns a pure JudgeResult the orchestrator maps one-to-one onto
 * the ADR-0008 rows; the Judge writes no SQLite and makes no network call of
 * its own (that lives behind the port).
 */
import type {
  AnchorRef,
  ContentChunk,
} from "../loader/rollout/codex-reader.ts";
import type { JudgeModelPort } from "./port.ts";
import { resolveDefaultJudgeModel } from "./anthropic-adapter.ts";
import { buildJudgePrompt } from "./prompt.ts";
import type {
  IntentValue,
  JudgedNarrative,
  JudgedSignal,
  JudgeResult,
  OutcomeValue,
} from "./types.ts";

export interface JudgeInput {
  readonly sessionId: string;
  readonly chunks: ReadonlyArray<ContentChunk>;
}

export interface JudgeConfig {
  readonly llm?: JudgeModelPort;
  readonly rubricVersion?: string;
  readonly promptVersion?: string;
  readonly retryBudget?: number;
  readonly now?: () => Date;
}

/** The date-stamped defaults for v1 (spec section 9.3). */
const DEFAULT_RUBRIC_VERSION = "2026-06-15";
const DEFAULT_PROMPT_VERSION = "2026-06-15";
const DEFAULT_RETRY_BUDGET = 2;

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

/** The 4-value ordinal Outcome vocabulary, low to high (ADR-0008). */
const OUTCOME_VALUES: ReadonlySet<string> = new Set<OutcomeValue>([
  "abandoned",
  "partial",
  "accomplished-with-correction",
  "accomplished-cleanly",
]);

const WHOLE_CONVERSATION_ASSIGNMENT = "whole-conversation";

/**
 * Judge one conversation. Resolves to a JudgeResult in every degraded case
 * (malformed output, unresolvable anchors, a failed port); it throws only on a
 * caller-contract violation (empty chunks where a conversation was promised),
 * which is a programming bug, not a run outcome.
 *
 * The retry posture (spec section 2e): on a parse failure or an invalid
 * structure (no parseable JSON object, or an Outcome present with no
 * assessment, so reasoning does not precede the label), re-prompt up to
 * `retryBudget` including the error so the model can repair. On exhaustion the
 * run is complete=false with incompleteReason="llm-unparseable". A transport
 * failure from the port yields complete=false, incompleteReason="llm-unavailable".
 */
export async function judgeConversation(
  input: JudgeInput,
  config: JudgeConfig = {},
): Promise<JudgeResult> {
  if (input.chunks.length === 0) {
    throw new Error("judgeConversation requires a non-empty chunk set");
  }
  // The single injected seam (spec section 3): omit config.llm and the
  // production default adapter over the engineer's configured Claude is
  // resolved from the environment; tests inject a deterministic stub.
  const llm = config.llm ?? resolveDefaultJudgeModel();
  const rubricVersion = config.rubricVersion ?? DEFAULT_RUBRIC_VERSION;
  const promptVersion = config.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const retryBudget = config.retryBudget ?? DEFAULT_RETRY_BUDGET;

  const prompt = buildJudgePrompt(input.chunks);
  let lastModel = "unknown";
  let parseError: string | undefined;

  // One initial attempt plus up to `retryBudget` repairs.
  for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
    let response;
    try {
      response = await llm.complete({
        system: prompt.system,
        user: repairedUser(prompt.user, parseError),
      });
    } catch {
      return failed(
        { judgeModel: lastModel, rubricVersion, promptVersion },
        "llm-unavailable",
      );
    }
    lastModel = response.model;

    const verdict = parseVerdict(response.text);
    const invalidity = validityError(verdict);
    if (invalidity !== undefined || verdict === undefined) {
      parseError = invalidity ?? "the response was not a JSON object";
      continue;
    }

    const provenance = {
      judgeModel: response.model,
      rubricVersion,
      promptVersion,
    };
    const signals = buildSignals(verdict, input.chunks);
    const narratives = buildNarratives(verdict, input.chunks);

    // The verdict parsed, but no signal grounded on the conversation: the run
    // is honestly incomplete with the signals absent, never a fabricated value
    // (spec section 5). Any honest narrative the judge could still write stands.
    if (signals.length === 0) {
      return {
        complete: false,
        provenance,
        signals,
        narratives,
        incompleteReason: "insufficient-evidence",
      };
    }

    return { complete: true, provenance, signals, narratives };
  }

  return failed(
    { judgeModel: lastModel, rubricVersion, promptVersion },
    "llm-unparseable",
  );
}

/** Append the prior parse error to the user prompt so the model can repair. */
function repairedUser(user: string, parseError: string | undefined): string {
  if (parseError === undefined) return user;
  return `${user}\n\nYour previous response could not be used: ${parseError}. Return only the JSON object described above.`;
}

/** A degraded JudgeResult: no signals, no narratives, an incomplete run. */
function failed(
  provenance: JudgeResult["provenance"],
  reason: NonNullable<JudgeResult["incompleteReason"]>,
): JudgeResult {
  return {
    complete: false,
    provenance,
    signals: [],
    narratives: [],
    incompleteReason: reason,
  };
}

interface ParsedClaim {
  readonly value?: unknown;
  readonly prose?: unknown;
  readonly anchors?: unknown;
}

interface ParsedVerdict {
  readonly intent?: ParsedClaim;
  readonly outcome?: ParsedClaim;
  readonly assessment?: ParsedClaim;
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
 * enough to assemble. The prose-before-Outcome rule (ADR-0008) is enforced
 * here: an Outcome present with no assessment prose is invalid, so the Judge
 * never constructs an Outcome that was not preceded by reasoning.
 */
function validityError(verdict: ParsedVerdict | undefined): string | undefined {
  if (verdict === undefined) {
    return "the response was not a JSON object";
  }
  const hasOutcome =
    verdict.outcome !== undefined && verdict.outcome.value !== undefined;
  const hasAssessment =
    verdict.assessment !== undefined &&
    typeof verdict.assessment.prose === "string";
  if (hasOutcome && !hasAssessment) {
    return "an Outcome was given without the required assessment prose, which must precede it";
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
    verdict.outcome !== undefined &&
    typeof verdict.outcome.value === "string" &&
    OUTCOME_VALUES.has(verdict.outcome.value)
  ) {
    const anchors = resolveAnchors(verdict.outcome.anchors, chunkByLineSeq);
    if (anchors.length > 0) {
      signals.push({
        scope: "assignment",
        assignmentId: WHOLE_CONVERSATION_ASSIGNMENT,
        signalName: "outcome",
        valueKind: "ordinal",
        value: verdict.outcome.value as OutcomeValue,
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
