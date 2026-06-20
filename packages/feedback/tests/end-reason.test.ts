/**
 * The pure per-harness session-end-reason normalization functions.
 *
 * Each maps a harness's native end reason onto the small harness-agnostic
 * normalized vocabulary, never failing: an unrecognized or absent native
 * reason maps to the catch-all `other`.
 */
import { expect, test } from "bun:test";
import {
  normalizeClaudeEndReason,
  normalizeCodexEndReason,
} from "../src/loader/translators/end-reason.ts";

test("an absent Claude reason normalizes to the catch-all other", () => {
  expect(normalizeClaudeEndReason(undefined)).toBe("other");
});

test("the observed Claude prompt_input_exit reason normalizes to user_exit", () => {
  expect(normalizeClaudeEndReason("prompt_input_exit")).toBe("user_exit");
});

test("an unrecognized Claude reason normalizes to the catch-all other", () => {
  expect(normalizeClaudeEndReason("some_future_reason")).toBe("other");
});

test("the Claude logout reason normalizes to user_exit (a deliberate exit)", () => {
  expect(normalizeClaudeEndReason("logout")).toBe("user_exit");
});

test("the Claude clear reason normalizes to cleared (a reset in place)", () => {
  expect(normalizeClaudeEndReason("clear")).toBe("cleared");
});

test("Claude's own other reason normalizes to the catch-all other", () => {
  expect(normalizeClaudeEndReason("other")).toBe("other");
});

test("Codex exposes no end reason, so it normalizes to the catch-all other", () => {
  expect(normalizeCodexEndReason(undefined)).toBe("other");
});
