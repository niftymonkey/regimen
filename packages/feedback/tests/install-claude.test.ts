/**
 * The Claude install wiring, exercised through the pure planners (no subprocess,
 * no filesystem). Proves step (d) needs no new code: the generic skill planner
 * targets Claude's `~/.claude/skills` from the contract, and the generic capture
 * planner wires Claude's six capture events into `settings.json` while
 * preserving the rest of that file (permissions, env), because Claude keeps its
 * hooks alongside other settings, unlike Codex's dedicated hooks.json.
 */
import { expect, test } from "bun:test";
import {
  planCaptureHooks,
  type HooksFile,
  type WireContext,
} from "../src/cli/install/capture-hooks.ts";
import { harnessContract, planSkillInstall } from "@regimen/shared";
import { harnessDescriptor } from "../src/harness/descriptor.ts";

const CONTRACT = harnessContract("claude");
if (CONTRACT === undefined) throw new Error("no claude contract registered");
const DESCRIPTOR = harnessDescriptor("claude");
if (DESCRIPTOR === undefined)
  throw new Error("no claude descriptor registered");

const CLONE = "/repo";

test("the skill planner targets Claude's skills subdir under its config home", () => {
  const plans = planSkillInstall({
    home: "/home/me/.claude",
    bundleDir: "/repo",
    contract: CONTRACT,
  });
  for (const plan of plans) {
    expect(plan.targetPath).toBe(
      `/home/me/.claude/skills/${plan.name}/SKILL.md`,
    );
  }
});

test("the capture planner wires Claude's six capture events", () => {
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(undefined, ctx);
  expect(Object.keys(plan.hooks.hooks ?? {}).sort()).toEqual([
    "PostToolUse",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "UserPromptSubmit",
  ]);
});

test("wiring Claude capture into settings.json preserves the file's other keys", () => {
  const existing: HooksFile = {
    permissions: { allow: ["Read", "Bash(git status *)"] },
    env: { FOO: "bar" },
  };
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(existing, ctx);
  // The permissions and env blocks survive the merge unchanged.
  expect(plan.hooks.permissions).toEqual({
    allow: ["Read", "Bash(git status *)"],
  });
  expect(plan.hooks.env).toEqual({ FOO: "bar" });
  // The capture leaf runs the existing claude-stamping producer script. Claude is
  // a nested-matcher-groups harness, so the plan's union widens to that shape here.
  const hooks = plan.hooks as HooksFile;
  const leaf = hooks.hooks?.SessionStart?.[0]?.hooks?.[0];
  expect(leaf?.command).toBe(`bun ${CLONE}/hooks/capture.ts`);
});
