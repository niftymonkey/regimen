/**
 * The write-time Outcome derivation (ADR-0017), observed through deriveOutcome.
 *
 * Outcome is derived from the two judged axes (`accomplishment` and
 * `correction-cost`) rather than emitted directly, so this exercises the mapping
 * onto the five-value worst-to-best spectrum: the floor, the middle, and the
 * three accomplished-by-correction values. Pure function: no store, no network.
 */
import { expect, test } from "bun:test";
import { deriveOutcome } from "../src/judged/outcome.ts";

test("a not-accomplished result derives the floor, ignoring any correction-cost", () => {
  expect(deriveOutcome("not-accomplished")).toBe("not-accomplished");
  expect(deriveOutcome("not-accomplished", "heavy")).toBe("not-accomplished");
});

test("a partial result derives the middle, ignoring any correction-cost", () => {
  expect(deriveOutcome("partial")).toBe("partial");
  expect(deriveOutcome("partial", "light")).toBe("partial");
});

test("an accomplished result derives by its correction-cost", () => {
  expect(deriveOutcome("accomplished", "heavy")).toBe(
    "accomplished-under-heavy-correction",
  );
  expect(deriveOutcome("accomplished", "light")).toBe(
    "accomplished-under-light-correction",
  );
  expect(deriveOutcome("accomplished", "none")).toBe("accomplished-cleanly");
});

test("an accomplished result with an absent correction-cost derives the clean top", () => {
  expect(deriveOutcome("accomplished")).toBe("accomplished-cleanly");
});
