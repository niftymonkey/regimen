/**
 * The Copilot install wiring, exercised through the pure planners (no subprocess,
 * no filesystem). Proves step (d) needs no new code: the generic skill planner
 * targets Copilot's `~/.copilot/skills` from the contract, and the generic
 * capture planner wires Copilot's six capture events through the descriptor,
 * running the copilot-stamping producer script while preserving the rest of the
 * hooks file.
 *
 * NOTE: Copilot's real on-disk hooks file is a flat `{ version, hooks: { event:
 * [leaf] } }` envelope, not the planner's nested-matcher-groups shape. This test
 * exercises only that the descriptor flows through the shared planner producing a
 * type-valid plan; the live-capture install + translator are deferred until the
 * Copilot hook payload taxonomy is producer-confirmed.
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

const CONTRACT = harnessContract("copilot");
if (CONTRACT === undefined) throw new Error("no copilot contract registered");
const DESCRIPTOR = harnessDescriptor("copilot");
if (DESCRIPTOR === undefined)
  throw new Error("no copilot descriptor registered");

const CLONE = "/repo";

test("the skill planner targets Copilot's skills subdir under its config home", () => {
  const plans = planSkillInstall({
    home: "/home/me/.copilot",
    bundleDir: "/repo",
    contract: CONTRACT,
  });
  for (const plan of plans) {
    expect(plan.targetPath).toBe(
      `/home/me/.copilot/skills/${plan.name}/SKILL.md`,
    );
  }
});

test("the capture planner wires Copilot's six capture events", () => {
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(undefined, ctx);
  expect(Object.keys(plan.hooks.hooks ?? {}).sort()).toEqual([
    "postToolUse",
    "preCompact",
    "preToolUse",
    "sessionEnd",
    "sessionStart",
    "userPromptSubmitted",
  ]);
});

test("wiring Copilot capture preserves the hooks file's other keys and runs the copilot producer", () => {
  const existing: HooksFile = {
    permissions: { allow: ["Read", "Bash(git status *)"] },
    env: { FOO: "bar" },
  };
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(existing, ctx);
  expect(plan.hooks.permissions).toEqual({
    allow: ["Read", "Bash(git status *)"],
  });
  expect(plan.hooks.env).toEqual({ FOO: "bar" });
  const leaf = plan.hooks.hooks?.sessionStart?.[0]?.hooks?.[0];
  expect(leaf?.command).toBe(`bun ${CLONE}/hooks/capture-copilot.ts`);
});
