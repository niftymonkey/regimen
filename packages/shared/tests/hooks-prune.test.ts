/**
 * The dead-leaf prune the shared engine adds for `regimen update`: reading a
 * hook command's script path, and the two-tier `planDeadLeafRemoval` that removes
 * only marked, dead leaves it can PROVE sit inside a Regimen clone while merely
 * reporting marked, dead leaves outside every clone (an engineer's own gate). The
 * command-path extractor is exercised against the real command shapes found in the
 * wild; the planner is exercised on both hooks formats. Pure: the on-disk
 * existence check and the clone roots are injected, so no filesystem is touched.
 */
import { expect, test } from "bun:test";
import {
  extractCommandPath,
  type LeafHook,
  type MatcherGroup,
  planDeadLeafRemoval,
  type PruneContext,
  type VersionedHooksFile,
} from "../src/install/hooks-engine.ts";

test("extractCommandPath reads a bun-run absolute script", () => {
  expect(extractCommandPath("bun /abs/path/capture-codex.ts")).toBe(
    "/abs/path/capture-codex.ts",
  );
});

test("extractCommandPath keeps a double-quoted path with spaces whole", () => {
  expect(
    extractCommandPath('bun "/abs/path with spaces/rm-rf-gate-codex.ts"'),
  ).toBe("/abs/path with spaces/rm-rf-gate-codex.ts");
});

test("extractCommandPath skips a leading VAR=value and the interpreter", () => {
  expect(
    extractCommandPath(
      'REGIMEN_HARNESS=codex bash "/abs/path/em-dash-gate.sh"',
    ),
  ).toBe("/abs/path/em-dash-gate.sh");
});

test("extractCommandPath returns undefined when no absolute path is present", () => {
  expect(extractCommandPath("echo hello")).toBeUndefined();
  expect(extractCommandPath("bun ./relative.ts")).toBeUndefined();
});

test("extractCommandPath reads a Windows drive-letter path", () => {
  expect(extractCommandPath("bun C:/regimen/capture.ts")).toBe(
    "C:/regimen/capture.ts",
  );
});

/** A nested hooks file with one event carrying the given leaves in one group. */
function nested(
  event: string,
  leaves: LeafHook[],
): { hooks: Record<string, MatcherGroup[]> } {
  return { hooks: { [event]: [{ hooks: leaves }] } };
}

/** A context where every script is missing, with the given clone roots. */
function allMissing(clonePaths: readonly string[]): PruneContext {
  return { scriptExists: () => false, clonePaths };
}

test("nested: a dead gate leaf under a recorded clone path is removed", () => {
  const command = "bun /recorded/regimen/packages/enforcement/examples/gate.ts";
  const existing = nested("PreToolUse", [
    { type: "command", command, _regimen: { v: 1, role: "gate", id: "rm-rf" } },
  ]);

  const plan = planDeadLeafRemoval(
    existing,
    "nested-matcher-groups",
    allMissing(["/recorded/regimen", "/current/regimen"]),
  );

  expect(plan.removed).toEqual([
    { event: "PreToolUse", role: "gate", id: "rm-rf", command },
  ]);
  expect(plan.reported).toEqual([]);
  // The emptied event is pruned entirely.
  expect(plan.hooks.hooks?.PreToolUse).toBeUndefined();
});

test("nested: a dead capture leaf under the current clone path is removed", () => {
  const existing = nested("PreToolUse", [
    {
      type: "command",
      command: "bun /current/regimen/packages/feedback/src/capture.ts",
      _regimen: { v: 1, role: "capture" },
    },
  ]);

  const plan = planDeadLeafRemoval(
    existing,
    "nested-matcher-groups",
    allMissing(["/recorded/regimen", "/current/regimen"]),
  );

  expect(plan.removed).toEqual([
    {
      event: "PreToolUse",
      role: "capture",
      command: "bun /current/regimen/packages/feedback/src/capture.ts",
    },
  ]);
  expect(plan.reported).toEqual([]);
});

test("nested: a dead gate leaf on an engineer path outside every clone is reported, not removed", () => {
  const existing = nested("PreToolUse", [
    {
      type: "command",
      command: "bun /home/user/my-gates/my-gate.ts",
      _regimen: { v: 1, role: "gate", id: "mine" },
    },
  ]);

  const plan = planDeadLeafRemoval(
    existing,
    "nested-matcher-groups",
    allMissing(["/recorded/regimen", "/current/regimen"]),
  );

  expect(plan.removed).toEqual([]);
  expect(plan.reported).toEqual([
    {
      event: "PreToolUse",
      role: "gate",
      id: "mine",
      command: "bun /home/user/my-gates/my-gate.ts",
    },
  ]);
  // The leaf is left in place untouched.
  expect(plan.hooks.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
});

test("nested: clone containment is by segment, so regimen-other is not treated as inside regimen", () => {
  const existing = nested("PreToolUse", [
    {
      type: "command",
      command: "bun /tmp/x/regimen-other/gate.ts",
      _regimen: { v: 1, role: "gate", id: "sibling" },
    },
  ]);

  const plan = planDeadLeafRemoval(
    existing,
    "nested-matcher-groups",
    allMissing(["/tmp/x/regimen"]),
  );

  expect(plan.removed).toEqual([]);
  expect(plan.reported.map((l) => l.id)).toEqual(["sibling"]);
});

test("nested: an unmarked leaf and a live marked leaf are never touched or reported", () => {
  const liveCommand = "bun /current/regimen/live.ts";
  const existing = nested("PreToolUse", [
    { type: "command", command: "user hook" },
    {
      type: "command",
      command: liveCommand,
      _regimen: { v: 1, role: "capture" },
    },
    {
      type: "command",
      command: "bun /current/regimen/dead.ts",
      _regimen: { v: 1, role: "gate", id: "dead" },
    },
  ]);
  const ctx: PruneContext = {
    scriptExists: (path) => path === "/current/regimen/live.ts",
    clonePaths: ["/current/regimen"],
  };

  const plan = planDeadLeafRemoval(existing, "nested-matcher-groups", ctx);

  expect(plan.removed.map((l) => l.id)).toEqual(["dead"]);
  expect(plan.reported).toEqual([]);
  const groups = (plan.hooks.hooks?.PreToolUse ?? []) as MatcherGroup[];
  const kept = groups.flatMap((g) => g.hooks);
  expect(kept.map((l) => l.command)).toEqual(["user hook", liveCommand]);
});

test("nested: an unmarked leaf with a dead absolute path is left alone", () => {
  const existing = nested("PreToolUse", [
    { type: "command", command: "bun /current/regimen/not-ours.ts" },
  ]);

  const plan = planDeadLeafRemoval(
    existing,
    "nested-matcher-groups",
    allMissing(["/current/regimen"]),
  );

  expect(plan.removed).toEqual([]);
  expect(plan.reported).toEqual([]);
  expect(plan.hooks.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
});

test("versioned: a dead marked leaf inside a clone is removed, foreign kept", () => {
  const existing: VersionedHooksFile = {
    version: 1,
    hooks: {
      PreToolUse: [
        { type: "command", command: "run user" },
        {
          type: "command",
          command: "bun /current/regimen/dead-copilot.ts",
          _regimen: { v: 1, role: "gate", id: "cop" },
        },
      ],
    },
  };

  const plan = planDeadLeafRemoval(
    existing,
    "versioned-command-leaves",
    allMissing(["/current/regimen"]),
  );
  const file = plan.hooks as VersionedHooksFile;

  expect(plan.removed.map((l) => l.id)).toEqual(["cop"]);
  expect(file.version).toBe(1);
  expect(file.hooks?.PreToolUse).toEqual([
    { type: "command", command: "run user" },
  ]);
});

test("a leaf whose command yields no path is never removed even if marked", () => {
  const existing = nested("PreToolUse", [
    {
      type: "command",
      command: "run some-alias",
      _regimen: { v: 1, role: "gate", id: "opaque" },
    },
  ]);

  const plan = planDeadLeafRemoval(
    existing,
    "nested-matcher-groups",
    allMissing(["/current/regimen"]),
  );

  expect(plan.removed).toEqual([]);
  expect(plan.reported).toEqual([]);
});
