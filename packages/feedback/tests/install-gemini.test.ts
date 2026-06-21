/**
 * The Gemini install wiring, exercised through the pure planners (no subprocess,
 * no filesystem). Proves step (d) needs no new code: the generic skill planner
 * targets Gemini's `~/.gemini/skills` from the contract, and the generic capture
 * planner wires Gemini's capture events through the descriptor into its
 * settings.json (the same nested-matcher-groups shape Codex and Claude use, so
 * the planner writes Gemini's real format with no divergence), running the
 * gemini-stamping producer script while preserving the rest of the hooks file.
 */
import { expect, test } from "bun:test";
import { planSkillInstall } from "../src/cli/install/skill.ts";
import {
  planCaptureHooks,
  type HooksFile,
  type WireContext,
} from "../src/cli/install/capture-hooks.ts";
import { harnessContract } from "@regimen/shared";
import { harnessDescriptor } from "../src/harness/descriptor.ts";

const CONTRACT = harnessContract("gemini");
if (CONTRACT === undefined) throw new Error("no gemini contract registered");
const DESCRIPTOR = harnessDescriptor("gemini");
if (DESCRIPTOR === undefined)
  throw new Error("no gemini descriptor registered");

const CLONE = "/repo";

test("the skill planner targets Gemini's skills subdir under its config home", () => {
  const plans = planSkillInstall({
    home: "/home/me/.gemini",
    bundleDir: "/repo",
    contract: CONTRACT,
  });
  for (const plan of plans) {
    expect(plan.targetPath).toBe(
      `/home/me/.gemini/skills/${plan.name}/SKILL.md`,
    );
  }
});

test("the capture planner wires Gemini's capture events", () => {
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(undefined, ctx);
  expect(Object.keys(plan.hooks.hooks ?? {}).sort()).toEqual([
    "AfterTool",
    "BeforeAgent",
    "BeforeTool",
    "PreCompress",
    "SessionEnd",
    "SessionStart",
  ]);
});

test("wiring Gemini capture preserves the hooks file's other keys and runs the gemini producer", () => {
  const existing: HooksFile = {
    permissions: { allow: ["Read"] },
    env: { FOO: "bar" },
  };
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(existing, ctx);
  expect(plan.hooks.permissions).toEqual({ allow: ["Read"] });
  expect(plan.hooks.env).toEqual({ FOO: "bar" });
  const leaf = plan.hooks.hooks?.SessionStart?.[0]?.hooks?.[0];
  expect(leaf?.command).toBe(`bun ${CLONE}/hooks/capture-gemini.ts`);
  expect(leaf?._regimen).toEqual({ v: 1, role: "capture" });
});
