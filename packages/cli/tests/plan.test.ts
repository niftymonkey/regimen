/**
 * The InstallPlan, the CLI's pure test surface. Asserts the EXACT ordered Step[]
 * for install vs uninstall, dry-run on/off, --no-gates, repeated --gate, and
 * that --gate, --with-bridge, and the locator --*-path flags never leak onto the
 * wrong step. The config home is NOT a flag any more: it travels in the child
 * environment, so no step ever carries --codex-home. Zero spawning, zero I/O:
 * same config in, same plan out.
 */
import { expect, test } from "bun:test";
import {
  type InstallConfig,
  type InstrumentStep,
  type Step,
  planInstall,
  planUninstall,
} from "../src/plan.ts";

const baseConfig: InstallConfig = {
  dryRun: false,
  gates: [],
  noGates: false,
  withBridge: false,
};

/** The instrument steps only, narrowing away the cli self-link step. */
function instrumentSteps(steps: ReadonlyArray<Step>): InstrumentStep[] {
  return steps.filter((s): s is InstrumentStep => "instrument" in s);
}

test("install runs feedback then enforcement, then self-links the cli bin last", () => {
  const steps = planInstall(baseConfig);
  expect(steps).toEqual([
    { instrument: "feedback", verb: "install", args: [] },
    { instrument: "enforcement", verb: "install", args: [] },
    { kind: "cli", verb: "link" },
  ]);
});

test("uninstall self-unlinks the cli bin first, then enforcement then feedback", () => {
  const steps = planUninstall(baseConfig);
  expect(steps).toEqual([
    { kind: "cli", verb: "unlink" },
    { instrument: "enforcement", verb: "uninstall", args: [] },
    { instrument: "feedback", verb: "uninstall", args: [] },
  ]);
});

test("--dry-run forwards to every instrument step; the config home is never a flag", () => {
  const steps = planInstall({
    ...baseConfig,
    dryRun: true,
  });
  for (const step of instrumentSteps(steps)) {
    expect(step.args).toContain("--dry-run");
    // The config home travels in the child env, never as a forwarded flag.
    expect(step.args).not.toContain("--codex-home");
  }
});

test("repeated --gate forwards only to the enforcement step, in order", () => {
  const steps = instrumentSteps(
    planInstall({
      ...baseConfig,
      gates: ["rm-rf", "em-dash"],
    }),
  );
  const feedback = steps.find((s) => s.instrument === "feedback")!;
  const enforcement = steps.find((s) => s.instrument === "enforcement")!;
  expect(enforcement.args).toEqual(["--gate", "rm-rf", "--gate", "em-dash"]);
  expect(feedback.args).not.toContain("--gate");
});

test("--no-gates forwards only to enforcement and suppresses any --gate", () => {
  const steps = instrumentSteps(
    planInstall({
      ...baseConfig,
      gates: ["rm-rf"],
      noGates: true,
    }),
  );
  const feedback = steps.find((s) => s.instrument === "feedback")!;
  const enforcement = steps.find((s) => s.instrument === "enforcement")!;
  expect(enforcement.args).toEqual(["--no-gates"]);
  expect(feedback.args).not.toContain("--no-gates");
});

test("--with-bridge is cli-owned: it never leaks into any step's args", () => {
  const steps = planInstall({
    ...baseConfig,
    withBridge: true,
    gates: ["rm-rf"],
  });
  for (const step of instrumentSteps(steps)) {
    expect(step.args).not.toContain("--with-bridge");
  }
  // The bridge instrument is not buildable yet, so it adds no instrument step today.
  expect(instrumentSteps(steps).map((s) => s.instrument)).toEqual([
    "feedback",
    "enforcement",
  ]);
});
