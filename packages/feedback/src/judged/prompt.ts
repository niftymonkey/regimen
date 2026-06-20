/**
 * The Judge's prompt construction, grounded in docs/feedback-surfacing.md
 * (S3 spec section 2d).
 *
 * The prompt is version-pinned and elicits, harness- and model-neutrally:
 * Intent (categorical, closed vocab), Outcome (the 4-value ordinal), and the
 * conversation assessment prose generated BEFORE the Outcome label. Each chunk
 * is presented with its citable id (its lineSeq); the judge cites only those
 * ids, and the Judge maps an id back to the chunk's real AnchorRef, so the
 * model never has to echo a 64-char hash. The judge reads the engineer's
 * inputs and the AI's actions only, never model-private reasoning, and never
 * grades software quality (ADR-0003, ADR-0008, feedback-surfacing.md).
 */
import type { ContentChunk } from "../loader/rollout/codex-reader.ts";

export interface JudgePrompt {
  readonly system: string;
  readonly user: string;
}

const INTENT_VOCAB =
  "refactor | bug-fix | feature | test-writing | exploration | schema-change | other";

const OUTCOME_VOCAB =
  "abandoned < partial < accomplished-with-correction < accomplished-cleanly";

/**
 * The rubric/instruction system prompt. Pins the closed vocabularies, the
 * prose-before-Outcome order, the citable-id anchor rule, and the two explicit
 * non-goals (transcript length, software quality).
 */
const SYSTEM = `You are Feedback's judge. You read one engineer-and-AI coding conversation and return a structured verdict. You judge how the work went, never whether the code is good.

You output exactly one JSON object with these keys, in this order:
1. "intent": { "value": <one of: ${INTENT_VOCAB}>, "anchors": [<chunk ids>] }
   Name what the engineer was trying to do. Read the engineer's prompts primarily, the AI's actions secondarily. Intent names the engineer's purpose, not what code changed. Use "other" only when no listed value fits; never force a wrong fit.
2. "assessment": { "prose": <a readable synthesis of how the conversation went>, "anchors": [<chunk ids>] }
   Write this BEFORE deciding the Outcome, so your reasoning precedes the label.
3. "outcome": { "value": <one of, low to high: ${OUTCOME_VOCAB}>, "anchors": [<chunk ids>] }
   Score whether the AI accomplished the assignment and how much steering it took. Do NOT score on transcript length. Do NOT grade software quality.

Anchors: each "anchors" array cites the chunk ids (the numbers in [brackets] below) that justify the claim. Cite at least one id per claim, and cite only ids that appear in the conversation. Do not invent ids.

Return only the JSON object, no prose around it.`;

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
): JudgePrompt {
  const user = [
    "Here is the conversation, one chunk per block, labeled with its citable id:",
    "",
    ...chunks.map(renderChunk),
  ].join("\n");
  return { system: SYSTEM, user };
}
