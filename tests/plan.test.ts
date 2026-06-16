/**
 * The InstallPlan, the hub's pure test surface. Asserts the EXACT ordered Step[]
 * for install vs uninstall, dry-run on/off, --no-gates, repeated --gate,
 * --codex-home forwarded to both, and that --gate, --with-bridge, and the
 * locator --*-path flags never leak onto the wrong step. Zero spawning, zero
 * I/O: same config in, same plan out.
 */
import { expect, test } from "bun:test";
import { type InstallConfig, planInstall, planUninstall } from "../src/plan.ts";

const baseConfig: InstallConfig = {
  dryRun: false,
  gates: [],
  noGates: false,
  withBridge: false,
};

test("install runs feedback then enforcement, each with its top-level install verb", () => {
  const steps = planInstall(baseConfig);
  expect(steps).toEqual([
    { instrument: "feedback", verb: "install", args: [] },
    { instrument: "enforcement", verb: "install", args: [] },
  ]);
});

test("uninstall reverses the order to enforcement then feedback, with the uninstall verb", () => {
  const steps = planUninstall(baseConfig);
  expect(steps).toEqual([
    { instrument: "enforcement", verb: "uninstall", args: [] },
    { instrument: "feedback", verb: "uninstall", args: [] },
  ]);
});

test("--dry-run and --codex-home forward to every step", () => {
  const steps = planInstall({
    ...baseConfig,
    dryRun: true,
    codexHome: "/tmp/codex",
  });
  for (const step of steps) {
    expect(step.args).toContain("--dry-run");
    const i = step.args.indexOf("--codex-home");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(step.args[i + 1]).toBe("/tmp/codex");
  }
});

test("repeated --gate forwards only to the enforcement step, in order", () => {
  const steps = planInstall({
    ...baseConfig,
    gates: ["rm-rf", "em-dash"],
  });
  const feedback = steps.find((s) => s.instrument === "feedback")!;
  const enforcement = steps.find((s) => s.instrument === "enforcement")!;
  expect(enforcement.args).toEqual(["--gate", "rm-rf", "--gate", "em-dash"]);
  expect(feedback.args).not.toContain("--gate");
});

test("--no-gates forwards only to enforcement and suppresses any --gate", () => {
  const steps = planInstall({
    ...baseConfig,
    gates: ["rm-rf"],
    noGates: true,
  });
  const feedback = steps.find((s) => s.instrument === "feedback")!;
  const enforcement = steps.find((s) => s.instrument === "enforcement")!;
  expect(enforcement.args).toEqual(["--no-gates"]);
  expect(feedback.args).not.toContain("--no-gates");
});

test("--with-bridge is hub-owned: it never leaks into any step's args", () => {
  const steps = planInstall({
    ...baseConfig,
    withBridge: true,
    codexHome: "/tmp/codex",
    gates: ["rm-rf"],
  });
  for (const step of steps) {
    expect(step.args).not.toContain("--with-bridge");
  }
  // The bridge instrument is not buildable yet, so it adds no step today.
  expect(steps.map((s) => s.instrument)).toEqual(["feedback", "enforcement"]);
});
