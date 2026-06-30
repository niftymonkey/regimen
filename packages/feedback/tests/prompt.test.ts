/**
 * The judge's SYSTEM rubric carries an explicit, distinct criterion for each of
 * the four Outcome labels, so the values discriminate rather than naming a bare
 * ordinal. Each criterion is judged from the engineer's inputs and the AI's
 * actions only, never software quality (Decision 4 of the judge-prompt design).
 */
import { expect, test } from "bun:test";
import type { ContentChunk } from "../src/loader/reader-types.ts";
import { buildJudgePrompt } from "../src/judged/prompt.ts";

const CHUNKS: ContentChunk[] = [
  {
    kind: "human_prompt",
    text: "add a test for the parser",
    anchor: { eventHash: "a".repeat(64) },
    lineSeq: 0,
  },
  {
    kind: "assistant_answer",
    text: "Done, the parser test passes.",
    anchor: { eventHash: "b".repeat(64) },
    lineSeq: 1,
  },
];

test("the SYSTEM rubric names each Outcome label", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("accomplished-cleanly");
  expect(system).toContain("accomplished-with-correction");
  expect(system).toContain("partial");
  expect(system).toContain("abandoned");
});

test("accomplished-cleanly carries the no-corrective-steering criterion", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("little or no corrective steering");
});

test("accomplished-with-correction carries the engineer-corrected criterion", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("corrected, redirected, or repaired");
});

test("partial carries the meaningful-progress-but-not-accomplished criterion", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain(
    "meaningful progress was made but the assignment was not accomplished",
  );
});

test("abandoned carries the dropped-or-unresolved criterion", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("dropped or left unresolved");
});

test("the SYSTEM rubric elicits the engagement signal with its closed vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"engagement"');
  expect(system).toContain("engaged | not-engaged");
});

test("the engagement signal is framed as orthogonal to the Outcome", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("orthogonal to the Outcome");
});

test("engagement carries the never-a-work-session criterion for not-engaged", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("never really became a work session");
});
