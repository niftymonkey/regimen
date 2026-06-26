/**
 * The Copilot install wiring, exercised through the pure planners (no subprocess,
 * no filesystem). Proves step (d) needs no new code: the generic skill planner
 * targets Copilot's `~/.copilot/skills` from the contract, and the generic
 * capture planner wires Copilot's six capture events through the descriptor,
 * running the copilot-stamping producer script while preserving the rest of the
 * hooks file.
 *
 * Copilot's hooks file is the flat `{ version, hooks: { event: [leaf] } }`
 * (`versioned-command-leaves`) envelope, which the planner now emits by branching
 * on the descriptor's contract format. The structural specifics of that path live
 * in install-capture-hooks-versioned.test.ts; this file proves the Copilot
 * descriptor flows through the shared `planCaptureHooks` entry point and produces
 * the versioned shape with the copilot-stamping producer. The live-capture install
 * + translator are deferred until the Copilot hook payload taxonomy is
 * producer-confirmed.
 */
import { expect, test } from "bun:test";
import {
  planCaptureHooks,
  type VersionedHooksFile,
  type WireContext,
} from "../src/cli/install/capture-hooks.ts";
import { harnessContract, planSkillInstall } from "@regimen/shared";
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
  const existing: VersionedHooksFile = {
    version: 1,
    permissions: { allow: ["Read", "Bash(git status *)"] },
    env: { FOO: "bar" },
  };
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(existing, ctx);
  const file = plan.hooks as VersionedHooksFile;
  expect(file.permissions).toEqual({
    allow: ["Read", "Bash(git status *)"],
  });
  expect(file.env).toEqual({ FOO: "bar" });
  // Versioned shape: a flat leaf directly in the event's array, no group wrapper.
  const leaf = file.hooks?.sessionStart?.[0];
  expect(leaf?.command).toBe(`bun ${CLONE}/hooks/capture-copilot.ts`);
});
