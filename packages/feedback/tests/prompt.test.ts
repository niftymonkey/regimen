/**
 * The judge's SYSTEM rubric carries an explicit, distinct criterion for each of
 * the four Outcome labels, so the values discriminate rather than naming a bare
 * ordinal. Each criterion is judged from the engineer's inputs and the AI's
 * actions only, never software quality (Decision 4 of the judge-prompt design).
 */
import { expect, test } from "bun:test";
import type { ContentChunk } from "../src/loader/reader-types.ts";
import { buildJudgePrompt } from "../src/judged/prompt.ts";
import type { EngineerSetup } from "../src/judged/setup.ts";

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

const SETUP: EngineerSetup = {
  conventions: [
    { scope: "project", text: "Harness- and model-agnostic by default." },
  ],
  practices: [
    { name: "tdd", summary: "red-green-refactor before writing code" },
  ],
};

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

test("injects a supplied convention's text and a practice's name when setup is present", () => {
  const prompt = buildJudgePrompt(CHUNKS, SETUP);
  const full = `${prompt.system}\n${prompt.user}`;
  expect(full).toContain("Harness- and model-agnostic by default.");
  expect(full).toContain("tdd");
});

test("the SYSTEM rubric gains the adherence instruction only when setup is present", () => {
  expect(buildJudgePrompt(CHUNKS, SETUP).system).toContain(
    "Expected-behaviors adherence",
  );
  expect(buildJudgePrompt(CHUNKS).system).not.toContain(
    "Expected-behaviors adherence",
  );
});

const EXPECTED_SETUP_BLIND_USER = [
  "Here is the conversation, one chunk per block, labeled with its citable id:",
  "",
  "[0] (human_prompt)\nadd a test for the parser",
  "[1] (assistant_answer)\nDone, the parser test passes.",
].join("\n");

test("reproduces the setup-blind prompt byte-for-byte when setup is omitted", () => {
  const blind = buildJudgePrompt(CHUNKS);
  expect(blind.user).toBe(EXPECTED_SETUP_BLIND_USER);
  expect(blind.user).not.toContain(
    "Expected behaviors (the engineer's own setup)",
  );
  expect(blind.system).not.toContain("Expected-behaviors adherence");
});
