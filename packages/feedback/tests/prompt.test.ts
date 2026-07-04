/**
 * The judge's SYSTEM rubric elicits the two Outcome axes (ADR-0017):
 * `accomplishment` (done-ness) and `correction-cost` (steering, when
 * accomplished), each with an explicit ordinal vocabulary and per-value
 * criteria. Each is judged from the engineer's inputs and the AI's actions only,
 * never software quality.
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

test("the SYSTEM rubric elicits the accomplishment axis with its ordinal vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"accomplishment"');
  expect(system).toContain("not-accomplished < partial < accomplished");
});

test("accomplishment names done-ness only, cause-free", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("no working result toward the stated intent");
  expect(system).toContain("the assignment's intent was met");
});

test("the SYSTEM rubric elicits the correction-cost axis with its ordinal vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"correction-cost"');
  expect(system).toContain("none < light < heavy");
});

test("correction-cost is emitted only when accomplished, abstaining otherwise", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("only when accomplishment is accomplished");
});

test("correction-cost carries the steering criterion", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("redirected, corrected, or repaired");
});

test("the SYSTEM rubric elicits the engagement signal with its closed vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"engagement"');
  expect(system).toContain("engaged | not-engaged");
});

test("the engagement signal is framed as orthogonal to the accomplishment", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("orthogonal to the accomplishment");
});

test("engagement carries the never-a-work-session criterion for not-engaged", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("never really became a work session");
});

test("the not-engaged definition drops the setup-blip phrasing (ADR-0017 wording fix)", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).not.toContain("setup blip");
});

test("the SYSTEM rubric elicits the verification signal with its closed vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"verification"');
  expect(system).toContain(
    "verified | accepted-unverified | over-verified | nothing-to-verify",
  );
});

test("verification is visible-check-only and abstains when unclear", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("visible");
  expect(system).toContain("OMIT the key");
});

test("verification anchors accepted-unverified on positive evidence of the skip", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("POSITIVE evidence of the skip");
});

test("the SYSTEM rubric elicits the attribution diagnostic with its closed vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"attribution"');
  expect(system).toContain(
    "framing | conducting | verification | leverage | ai | environment",
  );
});

test("attribution is on-shortfall only and names the single dominant cause", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("only when there is a shortfall");
  expect(system).toContain("single dominant cause");
});

test("attribution carries the blame-protection values for the AI and the environment", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("not the engineer's fault");
});

test("the SYSTEM rubric elicits the framing signal with its ordinal vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"framing"');
  expect(system).toContain("underspecified < adequate < clear");
});

test("the SYSTEM rubric elicits the conducting signal with its ordinal vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"conducting"');
  expect(system).toContain(
    "poorly-conducted < adequately-conducted < well-conducted",
  );
});

test("conducting is a quality of steering, distinct from correction-cost magnitude", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("decomposition");
  expect(system).toContain(
    "a well-conducted session can carry heavy correction",
  );
});

test("the SYSTEM rubric elicits the effort signal with its ordinal vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"effort"');
  expect(system).toContain("low < moderate < high");
});

test("effort rates the AI's own grind objectively, not worth", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("thrash");
  expect(system).toContain("not whether the work was worth it");
});

test("the SYSTEM rubric elicits the convention-adherence signal with its closed vocabulary", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain('"convention-adherence"');
  expect(system).toContain("followed | partially-followed | violated");
});

test("convention-adherence abstains when no conventions are in force", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain(
    "no conventions or practices are stated in the expected-behaviors block",
  );
});

test("convention-adherence is judged as an AI-action, not a person verdict", () => {
  const { system } = buildJudgePrompt(CHUNKS);
  expect(system).toContain("whether the AI honored");
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
