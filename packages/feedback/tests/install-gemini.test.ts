/**
 * The Gemini install wiring, exercised through the pure planners (no subprocess,
 * no filesystem). Proves step (d) needs no new code for skills: the generic skill
 * planner targets Gemini's `~/.gemini/skills` from the contract. For capture,
 * Gemini diverges from the other nested harnesses (see ADR-0011 and
 * docs/harness-divergences.md): a Session-1 controlled differential proved that
 * only a PROJECT-level `<workspace>/.gemini/settings.json` whose every hook group
 * carries a `name` AND a `matcher` fires headless; the user-level config-home file
 * with bare matcher-groups (no name/matcher) fires nothing. So the capture planner
 * wires Gemini's events into name+matcher-decorated groups, running the
 * gemini-stamping producer script while preserving the rest of the hooks file.
 */
import { expect, test } from "bun:test";
import {
  planCaptureHooks,
  type HooksFile,
  type WireContext,
} from "../src/cli/install/capture-hooks.ts";
import { harnessContract, planSkillInstall } from "@regimen/shared";
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

test("each Gemini capture group carries a name and a matcher (the headless-firing shape)", () => {
  const ctx: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
  const plan = planCaptureHooks(undefined, ctx);
  for (const event of DESCRIPTOR.capture.events) {
    const group = plan.hooks.hooks?.[event]?.[0];
    expect(group?.matcher).toBe("*");
    expect(group?.name).toBe(`regimen-capture-${event.toLowerCase()}`);
  }
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
  // Gemini is a nested-matcher-groups harness, so the plan's union widens to that
  // shape here.
  const hooks = plan.hooks as HooksFile;
  const leaf = hooks.hooks?.SessionStart?.[0]?.hooks?.[0];
  expect(leaf?.command).toBe(`bun ${CLONE}/hooks/capture-gemini.ts`);
  expect(leaf?._regimen).toEqual({ v: 1, role: "capture" });
});
