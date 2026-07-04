/**
 * The Judge's prompt construction, grounded in docs/feedback-surfacing.md
 * (S3 spec section 2d).
 *
 * The prompt is version-pinned and elicits, harness- and model-neutrally:
 * Intent (categorical, closed vocab), the two Outcome axes accomplishment and
 * correction-cost (ordinal, ADR-0017), and the conversation assessment prose
 * generated BEFORE the accomplishment and correction-cost labels. Each chunk
 * is presented with its citable id (its lineSeq); the judge cites only those
 * ids, and the Judge maps an id back to the chunk's real AnchorRef, so the
 * model never has to echo a 64-char hash. The judge reads the engineer's
 * inputs and the AI's actions only, never model-private reasoning, and never
 * grades software quality (ADR-0003, ADR-0008, feedback-surfacing.md).
 */
import type { ContentChunk } from "../loader/reader-types.ts";
import type { EngineerSetup } from "./setup.ts";

export interface JudgePrompt {
  readonly system: string;
  readonly user: string;
}

const INTENT_VOCAB =
  "refactor | bug-fix | feature | test-writing | exploration | schema-change | other";

const ACCOMPLISHMENT_VOCAB = "not-accomplished < partial < accomplished";

const CORRECTION_COST_VOCAB = "none < light < heavy";

const ENGAGEMENT_VOCAB = "engaged | not-engaged";

const VERIFICATION_VOCAB =
  "verified | accepted-unverified | over-verified | nothing-to-verify";

/**
 * The rubric/instruction system prompt. Pins the closed vocabularies, the
 * prose-before-label order, the citable-id anchor rule, and the two explicit
 * non-goals (transcript length, software quality). Outcome is split into the two
 * axes `accomplishment` (done-ness) and `correction-cost` (steering); the derived
 * Outcome read-key is computed at write time, never elicited (ADR-0017).
 */
const SYSTEM = `You are Feedback's judge. You read one engineer-and-AI coding conversation and return a structured verdict. You judge how the work went, never whether the code is good.

You output exactly one JSON object with these keys, in this order:
1. "intent": { "value": <one of: ${INTENT_VOCAB}>, "anchors": [<chunk ids>] }
   Name what the engineer was trying to do. Read the engineer's prompts primarily, the AI's actions secondarily. Intent names the engineer's purpose, not what code changed. Use "other" only when no listed value fits; never force a wrong fit.
2. "assessment": { "prose": <a readable synthesis of how the conversation went>, "anchors": [<chunk ids>] }
   Write this BEFORE deciding the accomplishment and correction-cost labels, so your reasoning precedes the labels.
3. "accomplishment": { "value": <one of, low to high: ${ACCOMPLISHMENT_VOCAB}>, "anchors": [<chunk ids>] }
   Score done-ness only, cause-free: whether the assignment's stated intent was reached, judged from the engineer's inputs and the AI's actions only. Apply these per-value criteria:
   - not-accomplished: no working result toward the stated intent was reached.
   - partial: meaningful progress was made but the intent was not met; sub-goals remain open or the result does not satisfy the intent.
   - accomplished: the assignment's intent was met.
   Do NOT score on transcript length. Do NOT grade software quality.
4. "correction-cost": { "value": <one of, low to high: ${CORRECTION_COST_VOCAB}>, "anchors": [<chunk ids>] }
   Emit this only when accomplishment is accomplished; otherwise OMIT the key entirely (the accomplishment floor already absorbs steering). Score how much the engineer redirected, corrected, or repaired the AI's course.
   - none: the AI held the engineer's intent and stated conventions with no corrective steering.
   - light: the engineer corrected the AI's course once or a small number of times.
   - heavy: the engineer repeatedly redirected or repaired the AI's course.
5. "engagement": { "value": <one of: ${ENGAGEMENT_VOCAB}>, "anchors": [<chunk ids>] }
   Judge whether the conversation genuinely became a work session on the assignment. This is orthogonal to the accomplishment: always decide it, whatever the accomplishment was.
   - engaged: the conversation genuinely became a work session on the assignment; the work was attempted in earnest. A real assignment derailed by tooling is engaged, not never-engaged.
   - not-engaged: the conversation never really became a work session on the assignment (a throwaway question, an aborted start, an unrelated detour); non-accomplishment here is not the AI failing at a real task.
6. "verification": { "value": <one of: ${VERIFICATION_VOCAB}>, "anchors": [<chunk ids>] }
   Judge whether the engineer's OWN visible check of the AI's output happened. A check must be VISIBLE in the transcript (the engineer reading a diff, running the code, or challenging the result); a silent reader is transcript-identical to a blind accepter, so absence of a visible check is NOT read as no-check. When it is genuinely unclear whether a check happened, OMIT the key entirely (abstain) rather than guessing. A harness-automatic hook or test run is the environment, not the engineer's verifying act.
   - verified: the engineer visibly checked the AI's substantive change before moving on.
   - accepted-unverified: emit only on POSITIVE evidence of the skip: a substantive AI change followed immediately by the engineer moving on with no visible read, run, or challenge. Anchor the two chunks that bracket the absent check (the AI change and the accept).
   - over-verified: the engineer checked far more than the change warranted (wasteful re-checking of a trivial or already-confirmed result).
   - nothing-to-verify: the conversation produced no AI change to check (a question answered, an exploration); anchor the no-change turns.

Anchors: each "anchors" array cites the chunk ids (the numbers in [brackets] below) that justify the claim. Cite at least one id per claim, and cite only ids that appear in the conversation. Do not invent ids.

Return only the JSON object, no prose around it.`;

/** The closing instruction of {@link SYSTEM}; the adherence line is inserted before it. */
const SYSTEM_CLOSER = "\n\nReturn only the JSON object, no prose around it.";

/**
 * Added to the SYSTEM rubric only when the engineer's expected behaviors are
 * supplied: it tells the judge to weigh whether the stated conventions and
 * established practices were honored, and to fold that into correction-cost
 * (unprompted adherence points to none; adherence only after steering points to
 * light or heavy).
 */
const ADHERENCE_INSTRUCTION = `Expected-behaviors adherence: the engineer's own expected behaviors are listed at the top of the conversation block below. Weigh whether the stated conventions and established practices were honored. Reflect this in the assessment prose, and treat it as a factor in correction-cost: conventions and practices followed unprompted point to none, conventions met only after the engineer steered point to light or heavy.`;

/**
 * Assemble the system rubric. With no setup it is the setup-blind baseline
 * verbatim; with setup it gains the single adherence instruction, inserted
 * before the closing line so the instruction is never baked into the baseline.
 */
function buildSystem(setup: EngineerSetup | undefined): string {
  if (setup === undefined) return SYSTEM;
  return SYSTEM.replace(
    SYSTEM_CLOSER,
    `\n\n${ADHERENCE_INSTRUCTION}${SYSTEM_CLOSER}`,
  );
}

/**
 * Render the engineer's setup as a clearly delimited expected-behaviors block,
 * or nothing when no setup is supplied so the prompt stays the setup-blind
 * baseline. The conventions are tagged by scope and the practice roster is named
 * with its one-line summary; the judge weighs whether they were honored.
 */
function renderSetup(setup: EngineerSetup | undefined): string[] {
  if (setup === undefined) return [];
  const lines = [
    "Expected behaviors (the engineer's own setup). Weigh whether these were honored:",
  ];
  for (const convention of setup.conventions) {
    lines.push(`- convention (${convention.scope}): ${convention.text}`);
  }
  for (const practice of setup.practices) {
    lines.push(`- practice ${practice.name}: ${practice.summary}`);
  }
  lines.push("");
  return lines;
}

/** Render one chunk as a citable, labeled block. */
function renderChunk(chunk: ContentChunk): string {
  return `[${chunk.lineSeq}] (${chunk.kind})\n${chunk.text}`;
}

/**
 * Build the version-pinned prompt for one conversation's content chunks. The
 * chunks arrive in lineSeq order; each is labeled with its citable id.
 */
export function buildJudgePrompt(
  chunks: ReadonlyArray<ContentChunk>,
  setup?: EngineerSetup,
): JudgePrompt {
  const user = [
    ...renderSetup(setup),
    "Here is the conversation, one chunk per block, labeled with its citable id:",
    "",
    ...chunks.map(renderChunk),
  ].join("\n");
  return { system: buildSystem(setup), user };
}
