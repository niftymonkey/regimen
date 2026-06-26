/**
 * The gate-scoped hooks planner across the two divergent harness install shapes
 * (pure). Copilot uses the `versioned-command-leaves` format (flat leaves under a
 * top-level `version`); Gemini uses `nested-matcher-groups` but each group must
 * carry a `name` and a `matcher` and installs project-level (per ADR-0011 and
 * docs/harness-divergences.md). Both wire onto the harness's own pre-tool event
 * name (Copilot `preToolUse`, Gemini `BeforeTool`), and every leaf carries the
 * enforcement marker `role:"gate"`, never `role:"capture"`. Exercised directly: no
 * filesystem.
 */
import { expect, test } from "bun:test";
import {
  type AuthoredGate,
  isGateLeaf,
  type LeafHook,
  type MatcherGroup,
  planGateHooks,
  planGateHooksRemoval,
  type VersionedHooksFile,
} from "../src/install/gate-hooks.ts";

const CLONE = "/home/me/regimen";
const RM_RF: AuthoredGate = {
  id: "rm-rf",
  scriptPath: "tests/fixtures/rm-rf-gate.ts",
};
const EM_DASH: AuthoredGate = {
  id: "em-dash",
  scriptPath: "gates/em-dash-gate.ts",
};
const INLINE: AuthoredGate = {
  id: "inline-message",
  scriptPath: "gates/inline-message-gate.ts",
};

test("copilot: gates wire as versioned flat leaves on preToolUse, each role:gate", () => {
  const plan = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "copilot",
    gates: [RM_RF, EM_DASH, INLINE],
  });

  const file = plan.hooks as VersionedHooksFile;
  // The versioned envelope: a top-level `version` and an events map of FLAT leaf
  // arrays, with no matcher-group wrapper.
  expect(file.version).toBe(1);
  const leaves = file.hooks?.preToolUse ?? [];
  expect(Array.isArray(leaves)).toBe(true);
  // Every leaf is a flat command leaf (no nested `hooks` array) marked role:gate.
  for (const leaf of leaves) {
    expect(leaf.type).toBe("command");
    expect((leaf as { hooks?: unknown }).hooks).toBeUndefined();
    expect(leaf._regimen?.role).toBe("gate");
  }
  expect(leaves.map((l) => l._regimen)).toEqual([
    { v: 1, role: "gate", id: "rm-rf" },
    { v: 1, role: "gate", id: "em-dash" },
    { v: 1, role: "gate", id: "inline-message" },
  ]);
  expect(leaves[0]?.command).toBe(
    `REGIMEN_HARNESS=copilot bun "${CLONE}/tests/fixtures/rm-rf-gate.ts"`,
  );
  // No capture is ever wired, and no claude/codex-style PreToolUse event appears.
  expect(leaves.some((l) => l._regimen?.role === "capture")).toBe(false);
  expect(file.hooks?.PreToolUse).toBeUndefined();
  expect(plan.added).toContainEqual({ event: "preToolUse", id: "rm-rf" });
});

test("copilot: a user leaf and a foreign capture leaf are preserved before the gates", () => {
  const userLeaf: LeafHook = {
    type: "command",
    command: "echo hi",
    matcher: "shell",
  };
  const captureLeaf: LeafHook = {
    type: "command",
    command: "bun /home/me/regimen-feedback/hooks/capture-copilot.ts",
    _regimen: { v: 1, role: "capture" },
  };
  const existing: VersionedHooksFile = {
    version: 1,
    hooks: { preToolUse: [userLeaf, captureLeaf] },
  };

  const plan = planGateHooks(existing, {
    clonePath: CLONE,
    harness: "copilot",
    gates: [RM_RF],
  });

  const leaves = (plan.hooks as VersionedHooksFile).hooks?.preToolUse ?? [];
  // The user leaf and the foreign capture leaf stay first and byte-identical; the
  // gate is appended flat after them.
  expect(leaves[0]).toEqual(userLeaf);
  expect(leaves[1]).toEqual(captureLeaf);
  expect(leaves[2]?._regimen).toEqual({ v: 1, role: "gate", id: "rm-rf" });
});

test("copilot: wire then unwire restores the original versioned file (round-trip)", () => {
  const original: VersionedHooksFile = {
    version: 1,
    hooks: {
      preToolUse: [
        {
          type: "command",
          command: "bun /home/me/regimen-feedback/hooks/capture-copilot.ts",
          _regimen: { v: 1, role: "capture" },
        },
      ],
    },
  };
  const wired = planGateHooks(original, {
    clonePath: CLONE,
    harness: "copilot",
    gates: [RM_RF, EM_DASH],
  }).hooks;
  // planGateHooksRemoval reports `.hooks` as the nested HooksFile, but the
  // versioned-command-leaves round-trip returns the same versioned shape it was
  // given. Both file shapes share the `Record<string, unknown>` index signature,
  // so comparing through it lets the deep-equality check run against the
  // VersionedHooksFile original with no cast.
  const restored: Record<string, unknown> = planGateHooksRemoval(
    wired,
    "versioned-command-leaves",
  ).hooks;
  expect(restored).toEqual(original);
});

test("gemini: gates wire as a named+matched nested group on BeforeTool, each role:gate", () => {
  const plan = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "gemini",
    gates: [RM_RF, EM_DASH, INLINE],
  });

  // Gemini's pre-tool boundary is BeforeTool, not PreToolUse.
  expect(plan.hooks.hooks?.PreToolUse).toBeUndefined();
  const groups = (plan.hooks.hooks?.BeforeTool ?? []) as MatcherGroup[];
  expect(groups).toHaveLength(1);
  const group = groups[0]!;
  // The shape ADR-0011 proved fires headless: each group carries a `name` AND a
  // `matcher`; the nested-only writer with neither does not fire.
  expect(group.name).toBe("regimen-gate-BeforeTool");
  expect(group.matcher).toBe("*");

  const leaves = group.hooks;
  expect(leaves.map((l) => l._regimen)).toEqual([
    { v: 1, role: "gate", id: "rm-rf" },
    { v: 1, role: "gate", id: "em-dash" },
    { v: 1, role: "gate", id: "inline-message" },
  ]);
  for (const leaf of leaves) expect(leaf._regimen?.role).toBe("gate");
  expect(leaves[0]?.command).toBe(
    `REGIMEN_HARNESS=gemini bun "${CLONE}/tests/fixtures/rm-rf-gate.ts"`,
  );
  expect(plan.added).toContainEqual({ event: "BeforeTool", id: "rm-rf" });
});

test("gemini: a user group and a foreign capture leaf are preserved before the gate group", () => {
  const captureGroup: MatcherGroup = {
    name: "regimen-capture-beforetool",
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: "bun /home/me/regimen-feedback/hooks/capture-gemini.ts",
        _regimen: { v: 1, role: "capture" },
      },
    ],
  };
  const existing = { hooks: { BeforeTool: [captureGroup] } };

  const plan = planGateHooks(existing, {
    clonePath: CLONE,
    harness: "gemini",
    gates: [RM_RF],
  });

  const groups = (plan.hooks.hooks?.BeforeTool ?? []) as MatcherGroup[];
  // The capture group stays first and byte-identical; the named+matched gate
  // group is appended after it.
  expect(groups[0]).toEqual(captureGroup);
  expect(groups[1]?.name).toBe("regimen-gate-BeforeTool");
  expect(groups[1]?.matcher).toBe("*");
  expect(groups[1]?.hooks[0]?._regimen).toEqual({
    v: 1,
    role: "gate",
    id: "rm-rf",
  });
});

test("gemini: re-applying the same wiring is idempotent (one gate group, nothing added)", () => {
  const ctx = {
    clonePath: CLONE,
    harness: "gemini" as const,
    gates: [RM_RF],
  };
  const first = planGateHooks(undefined, ctx);
  const second = planGateHooks(first.hooks, ctx);

  expect(second.added).toEqual([]);
  expect(second.hooks).toEqual(first.hooks);
  const groups = (second.hooks.hooks?.BeforeTool ?? []) as MatcherGroup[];
  expect(groups.filter((g) => g.hooks.some(isGateLeaf))).toHaveLength(1);
  expect(groups[0]?.name).toBe("regimen-gate-BeforeTool");
});
