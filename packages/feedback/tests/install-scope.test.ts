/**
 * The install-scope and installable-harness helpers the unified `regimen` CLI
 * consumes for the install manifest (ADR-0012). Scope is the feedback-private
 * call (it reads the descriptor's `groupDecoration`), so it lives here and the
 * dispatcher stays harness-agnostic: Gemini installs per-workspace
 * (`workspace:<cwd>`), every other harness into its config home
 * (`config-home`). `installableHarnesses` is the set the CLI loops for
 * `install --all` without restating the harness list.
 */
import { expect, test } from "bun:test";
import { installableHarnesses, installScope } from "../src/cli/index.ts";

test("installScope records gemini per-workspace as workspace:<cwd>", () => {
  expect(installScope("gemini", "/home/dev/project-a")).toBe(
    "workspace:/home/dev/project-a",
  );
});

test("installScope is config-home for a harness without a group decoration (codex)", () => {
  expect(installScope("codex", "/home/dev/project-a")).toBe("config-home");
});

test("installableHarnesses are exactly the descriptor-backed harnesses", () => {
  expect([...installableHarnesses()].sort()).toEqual([
    "claude",
    "codex",
    "copilot",
    "gemini",
  ]);
});
