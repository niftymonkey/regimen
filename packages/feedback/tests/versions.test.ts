/**
 * Characterization of the judge version stamps (the single source of truth).
 *
 * Pins the two exported version values so a bump is a deliberate, visible edit
 * in one place rather than a silent drift between the judge and the assess
 * orchestrator, which historically held duplicate copies.
 */
import { expect, test } from "bun:test";
import { PROMPT_VERSION, RUBRIC_VERSION } from "../src/judged/versions.ts";

test("RUBRIC_VERSION is the per-label-criteria date-stamped value", () => {
  expect(RUBRIC_VERSION).toBe("2026-06-29");
});

test("PROMPT_VERSION is the v1 date-stamped value", () => {
  expect(PROMPT_VERSION).toBe("2026-06-15");
});
