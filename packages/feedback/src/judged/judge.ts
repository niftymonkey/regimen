/**
 * The Judge: judgeConversation, the one deep new module of S3 (spec section 2).
 *
 * A narrow interface over a body that hides prompt construction (grounded in
 * docs/feedback-surfacing.md), the LLM round-trip behind the JudgeModelPort
 * seam, bounded retry, and fail-closed assembly. The parse, closed-vocabulary
 * enforcement, enumerated-chunk-id anchor citation with membership validation,
 * and signal/narrative assembly now live in the shared `verdict.ts` pipeline, so
 * the tier C agent recorder runs the identical body. The Judge writes no SQLite
 * and makes no network call of its own (that lives behind the port).
 */
import type { ContentChunk } from "../loader/reader-types.ts";
import type { JudgeModelPort } from "./port.ts";
import { resolveJudgeModel } from "./resolve.ts";
import { buildJudgePrompt } from "./prompt.ts";
import type { EngineerSetup } from "./setup.ts";
import { PROMPT_VERSION, RUBRIC_VERSION } from "./versions.ts";
import type { JudgeBackend, JudgeResult } from "./types.ts";
import { assembleVerdict } from "./verdict.ts";

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
  /**
   * The engineer's setup (the expected behaviors) the prompt weighs, resolved by
   * the orchestrator as of the conversation's time. Optional and additive: when
   * absent the prompt is byte-identical to the setup-blind baseline.
   */
  readonly setup?: EngineerSetup;
  /**
   * The backend the resolved port runs (api or cli), stamped onto every
   * provenance this pass writes so a mixed-backend corpus is sliceable and
   * honest (judge-backends design decision 4). Never self-reported: the caller
   * passes the tag the resolver built. Absent on the pre-backends default.
   */
  readonly judgeBackend?: JudgeBackend;
}

const DEFAULT_RETRY_BUDGET = 2;

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
  const llm = config.llm ?? resolveJudgeModel().port;
  const rubricVersion = config.rubricVersion ?? RUBRIC_VERSION;
  const promptVersion = config.promptVersion ?? PROMPT_VERSION;
  const retryBudget = config.retryBudget ?? DEFAULT_RETRY_BUDGET;

  const prompt = buildJudgePrompt(input.chunks, config.setup);
  let lastModel = "unknown";
  let repairMessage: string | undefined;
  let anchorRepairAttempted = false;

  // One initial attempt plus up to `retryBudget` repairs.
  for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
    let response;
    try {
      response = await llm.complete({
        system: prompt.system,
        user: repairedUser(prompt.user, repairMessage),
      });
    } catch (err) {
      return failed(
        provenanceOf(lastModel, rubricVersion, promptVersion, config),
        "llm-unavailable",
        incompleteDetail(err),
      );
    }
    lastModel = response.model;

    const outcome = assembleVerdict(response.text, input.chunks);
    if (!outcome.ok) {
      repairMessage = outcome.reason;
      continue;
    }

    // Repair-retry on unresolved anchors (spec: make miscitation rare at the
    // source). When the model valued a field but every cited id missed, re-prompt
    // ONCE telling it to cite only real ids, so a hallucinated citation is
    // corrected rather than silently dropping the signal or under-anchoring the
    // narrative. Bounded to one extra call (anchorRepairAttempted) and only while
    // a further attempt remains; on exhaustion the loop accepts the assembled
    // verdict, falling back to graceful degradation (the prose is kept).
    if (
      outcome.underAnchored.length > 0 &&
      !anchorRepairAttempted &&
      attempt < retryBudget
    ) {
      anchorRepairAttempted = true;
      repairMessage = anchorRepairMessage(outcome.underAnchored);
      continue;
    }

    const provenance = provenanceOf(
      response.model,
      rubricVersion,
      promptVersion,
      config,
    );

    // The verdict parsed, but no signal grounded on the conversation: the run
    // is honestly incomplete with the signals absent, never a fabricated value
    // (spec section 5). Any honest narrative the judge could still write stands.
    if (outcome.signals.length === 0) {
      return {
        complete: false,
        provenance,
        signals: outcome.signals,
        narratives: outcome.narratives,
        incompleteReason: "insufficient-evidence",
      };
    }

    return {
      complete: true,
      provenance,
      signals: outcome.signals,
      narratives: outcome.narratives,
    };
  }

  return failed(
    provenanceOf(lastModel, rubricVersion, promptVersion, config),
    "llm-unparseable",
  );
}

/** Build the run provenance, carrying the backend tag when the caller passed one. */
function provenanceOf(
  judgeModel: string,
  rubricVersion: string,
  promptVersion: string,
  config: JudgeConfig,
): JudgeResult["provenance"] {
  return {
    judgeModel,
    rubricVersion,
    promptVersion,
    ...(config.judgeBackend === undefined
      ? {}
      : { judgeBackend: config.judgeBackend }),
  };
}

/** Append the prior repair note to the user prompt so the model can repair. */
function repairedUser(user: string, repairMessage: string | undefined): string {
  if (repairMessage === undefined) return user;
  return `${user}\n\nYour previous response could not be used: ${repairMessage}. Return only the JSON object described above.`;
}

/**
 * The repair note for a response whose fields lack valid chunk citations, whether
 * they cited no ids at all or cited ids that match no real chunk. It names the
 * under-anchored fields and instructs the model to cite only ids from the
 * enumerated list, so the re-emitted verdict grounds on real chunks.
 */
function anchorRepairMessage(fields: ReadonlyArray<string>): string {
  return `these fields are missing valid chunk citations (they cited no ids, or ids that match no provided chunk): ${fields.join(", ")}. Cite only ids from the enumerated chunk list above, and re-emit the full JSON object`;
}

/** How much of the backend's failure message is kept, in characters. */
const DETAIL_LIMIT = 200;

/** A degraded JudgeResult: no signals, no narratives, an incomplete run. */
function failed(
  provenance: JudgeResult["provenance"],
  reason: NonNullable<JudgeResult["incompleteReason"]>,
  detail?: string,
): JudgeResult {
  return {
    complete: false,
    provenance,
    signals: [],
    narratives: [],
    incompleteReason: reason,
    ...(detail === undefined ? {} : { incompleteDetail: detail }),
  };
}

/**
 * What the backend said, for a failure a reason label alone cannot diagnose.
 * The message is written to the store and printed to stdout, so credentials are
 * stripped first: URL userinfo, and any long unbroken token, which is the shape
 * every provider's key takes and no prose does. Truncated, since the value is
 * for telling one failure from another, not for reading a stack trace.
 */
function incompleteDetail(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = message
    .replace(/:\/\/[^/\s@]*@/g, "://[redacted]@")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
  if (redacted.length === 0) return undefined;
  return redacted.length > DETAIL_LIMIT
    ? `${redacted.slice(0, DETAIL_LIMIT - 1)}\u2026`
    : redacted;
}
