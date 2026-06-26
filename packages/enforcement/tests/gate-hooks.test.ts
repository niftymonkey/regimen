/**
 * The gate-scoped hooks.json planner for the nested-matcher-groups format
 * (pure). Exercised directly: each test passes a parsed hooks.json object (or
 * undefined for a fresh file) and asserts on the returned object. No filesystem.
 * Mirrors Feedback's capture-hooks planner test, scoped to gates only: this
 * planner must never touch a capture leaf or a user hook.
 *
 * Enforcement ships no gate catalog, so the planner wires AUTHORED gates (an `id`
 * the engineer names plus the body's `scriptPath`); these tests author gates
 * against the rm-rf fixture body to prove the wiring shape.
 */
import { expect, test } from "bun:test";
import {
  type AuthoredGate,
  isGateLeaf,
  type LeafHook,
  planGateHooks,
  planGateHooksRemoval,
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

/** All leaf hooks across every group on one event, in order. */
function leavesOn(
  plan: { hooks: { hooks?: Record<string, unknown> } },
  event: string,
): LeafHook[] {
  const groups = (plan.hooks.hooks?.[event] ?? []) as Array<{
    hooks: LeafHook[];
  }>;
  return groups.flatMap((g) => g.hooks);
}

test("a fresh file wires the authored gates onto PreToolUse only, each marked", () => {
  const plan = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF, EM_DASH, INLINE],
  });

  const pre = leavesOn(plan, "PreToolUse");
  expect(pre.map((l) => l._regimen)).toEqual([
    { v: 1, role: "gate", id: "rm-rf" },
    { v: 1, role: "gate", id: "em-dash" },
    { v: 1, role: "gate", id: "inline-message" },
  ]);
  expect(pre[0]?.command).toBe(
    `REGIMEN_HARNESS=codex bun "${CLONE}/tests/fixtures/rm-rf-gate.ts"`,
  );
  expect(pre[1]?.command).toBe(
    `REGIMEN_HARNESS=codex bun "${CLONE}/gates/em-dash-gate.ts"`,
  );

  // No capture is ever wired by this planner, and no other event is touched.
  expect(pre.some((l) => l._regimen?.role === "capture")).toBe(false);
  expect(plan.hooks.hooks?.SessionStart).toBeUndefined();
  expect(plan.added).toContainEqual({ event: "PreToolUse", id: "rm-rf" });
});

test("the planner stamps the gate commands with the harness it is given", () => {
  const plan = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "claude",
    gates: [RM_RF, EM_DASH],
  });
  const pre = leavesOn(plan, "PreToolUse");
  // Every gate command carries the wired harness explicitly so the running gate
  // reads the harness the installer detected rather than guessing.
  expect(pre[0]?.command).toBe(
    `REGIMEN_HARNESS=claude bun "${CLONE}/tests/fixtures/rm-rf-gate.ts"`,
  );
  expect(pre[1]?.command).toBe(
    `REGIMEN_HARNESS=claude bun "${CLONE}/gates/em-dash-gate.ts"`,
  );
});

test("isGateLeaf recognizes by marker, not by command string", () => {
  const gate: LeafHook = {
    type: "command",
    command: "bun /anywhere/gates/rm-rf-gate.ts",
    _regimen: { v: 1, role: "gate", id: "rm-rf" },
  };
  const capture: LeafHook = {
    type: "command",
    command: "bun /anywhere/hooks/capture-codex.ts",
    _regimen: { v: 1, role: "capture" },
  };
  const userLookalike: LeafHook = {
    type: "command",
    command: "bun /home/me/regimen/gates/rm-rf-gate.ts",
  };
  expect(isGateLeaf(gate)).toBe(true);
  expect(isGateLeaf(capture)).toBe(false);
  expect(isGateLeaf(userLookalike)).toBe(false);
});

test("planGateHooksRemoval is a no-op on an empty or absent file", () => {
  expect(planGateHooksRemoval(undefined).removed).toEqual([]);
  const empty = planGateHooksRemoval({ hooks: {} });
  expect(empty.removed).toEqual([]);
  expect(empty.hooks).toEqual({ hooks: {} });
});

test("a capture leaf is preserved verbatim and gates land AFTER it", () => {
  const captureLeaf: LeafHook = {
    type: "command",
    command: "bun /home/me/regimen-feedback/hooks/capture-codex.ts",
    _regimen: { v: 1, role: "capture" },
  };
  const existing = {
    hooks: { PreToolUse: [{ hooks: [captureLeaf] }] },
  };

  const plan = planGateHooks(existing, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF],
  });

  const pre = leavesOn(plan, "PreToolUse");
  // Capture stays first and byte-identical; the gate is appended after it.
  expect(pre[0]).toEqual(captureLeaf);
  expect(pre[1]?._regimen).toEqual({ v: 1, role: "gate", id: "rm-rf" });
  // The capture leaf is never reordered, duplicated, or stripped.
  expect(pre.filter((l) => l._regimen?.role === "capture")).toHaveLength(1);
  // The original input is not mutated.
  expect(existing.hooks.PreToolUse[0]?.hooks).toHaveLength(1);
});

test("user hooks and unknown keys are preserved in place; gates appended after", () => {
  const userGate: LeafHook = {
    type: "command",
    command: "bun /home/me/my-own-gate.ts",
    matcher: "Bash",
  };
  const existing = {
    hooks: {
      PreToolUse: [{ hooks: [userGate], note: "user group" }],
      Notification: [
        { hooks: [{ type: "command", command: "say hi" } as LeafHook] },
      ],
    },
    $schema: "https://example.com/codex-hooks.json",
  };

  const plan = planGateHooks(existing, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF],
  });

  // The user's PreToolUse group stays first and byte-identical, unknown keys too.
  const preGroups = (plan.hooks.hooks?.PreToolUse ?? []) as Array<{
    hooks: LeafHook[];
    note?: string;
  }>;
  expect(preGroups[0]?.hooks[0]).toEqual(userGate);
  expect(preGroups[0]?.note).toBe("user group");
  const pre = leavesOn(plan, "PreToolUse");
  expect(pre[0]).toEqual(userGate);
  expect(pre[1]?._regimen).toEqual({ v: 1, role: "gate", id: "rm-rf" });

  // The untouched event and the top-level key survive verbatim.
  expect(leavesOn(plan, "Notification")[0]?.command).toBe("say hi");
  expect(plan.hooks.$schema).toBe("https://example.com/codex-hooks.json");
});

test("re-applying the same wiring is idempotent: nothing added, identical output", () => {
  const ctx = {
    clonePath: CLONE,
    harness: "codex" as const,
    gates: [RM_RF],
  };
  const first = planGateHooks(undefined, ctx);
  const second = planGateHooks(first.hooks, ctx);

  expect(second.added).toEqual([]);
  expect(second.hooks).toEqual(first.hooks);
  expect(second.unchanged).toContainEqual({ event: "PreToolUse", id: "rm-rf" });
  // Still exactly one gate leaf, not two.
  expect(leavesOn(second, "PreToolUse").filter(isGateLeaf)).toHaveLength(1);
});

test("a re-run that re-supplies no gates preserves the wired gate verbatim", () => {
  const first = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF],
  });
  // A later run that authors nothing new must keep the already-wired gate exactly
  // as it is on disk (its command preserved), not drop it or blank its path.
  const second = planGateHooks(first.hooks, {
    clonePath: CLONE,
    harness: "codex",
    gates: [],
  });
  const pre = leavesOn(second, "PreToolUse").filter(isGateLeaf);
  expect(pre).toHaveLength(1);
  expect(pre[0]?.command).toBe(
    `REGIMEN_HARNESS=codex bun "${CLONE}/tests/fixtures/rm-rf-gate.ts"`,
  );
  expect(second.added).toEqual([]);
});

test("two authored gates with the same basename but distinct ids both wire", () => {
  // Two distinct gates can share a filename in different directories (the
  // engineer's own naming). The dedup must distinguish them by identity, not by
  // basename, so neither is silently dropped.
  const repoGate: AuthoredGate = {
    id: "repo-no-secrets",
    scriptPath: "gates/repo/no-secrets-gate.ts",
  };
  const orgGate: AuthoredGate = {
    id: "org-no-secrets",
    scriptPath: "gates/org/no-secrets-gate.ts",
  };
  const plan = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "codex",
    gates: [repoGate, orgGate],
  });

  const ids = leavesOn(plan, "PreToolUse")
    .filter(isGateLeaf)
    .map((l) => l._regimen?.id);
  expect(ids).toEqual(["repo-no-secrets", "org-no-secrets"]);
  expect(plan.added).toContainEqual({
    event: "PreToolUse",
    id: "repo-no-secrets",
  });
  expect(plan.added).toContainEqual({
    event: "PreToolUse",
    id: "org-no-secrets",
  });
});

test("apply is additive: a later run with a different gate keeps the earlier one", () => {
  const first = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF],
  });
  const second = planGateHooks(first.hooks, {
    clonePath: CLONE,
    harness: "codex",
    gates: [EM_DASH],
  });

  const gateIds = leavesOn(second, "PreToolUse")
    .filter(isGateLeaf)
    .map((l) => l._regimen?.id);
  expect(gateIds).toEqual(["rm-rf", "em-dash"]);
  expect(second.unchanged).toContainEqual({ event: "PreToolUse", id: "rm-rf" });
  expect(second.added).toContainEqual({ event: "PreToolUse", id: "em-dash" });
});

test("a moved clone re-homes the gate command in place without duplicating", () => {
  const first = planGateHooks(undefined, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF],
  });
  const moved = "/opt/regimen";
  const second = planGateHooks(first.hooks, {
    clonePath: moved,
    harness: "codex",
    gates: [RM_RF],
  });

  const pre = leavesOn(second, "PreToolUse").filter(isGateLeaf);
  expect(pre).toHaveLength(1);
  expect(pre[0]?.command).toBe(
    `REGIMEN_HARNESS=codex bun "${moved}/tests/fixtures/rm-rf-gate.ts"`,
  );
});

test("removal strips exactly the gate entries, keeps capture and user, prunes emptied structure", () => {
  const captureLeaf: LeafHook = {
    type: "command",
    command: "bun /home/me/regimen-feedback/hooks/capture-codex.ts",
    _regimen: { v: 1, role: "capture" },
  };
  const userGate: LeafHook = {
    type: "command",
    command: "bun /home/me/my-own-gate.ts",
  };
  const existing = {
    hooks: {
      SessionStart: [{ hooks: [captureLeaf] }],
      PreToolUse: [{ hooks: [captureLeaf, userGate] }],
    },
  };
  const wired = planGateHooks(existing, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF],
  }).hooks;

  const plan = planGateHooksRemoval(wired);

  // The gate is gone; capture and the user gate remain, in place.
  const pre = (plan.hooks.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
  expect(pre.filter(isGateLeaf)).toHaveLength(0);
  expect(pre).toContainEqual(captureLeaf);
  expect(pre).toContainEqual(userGate);
  // Capture-only events survive intact.
  expect(plan.hooks.hooks?.SessionStart).toEqual([{ hooks: [captureLeaf] }]);
  expect(plan.removed).toContainEqual({ event: "PreToolUse", id: "rm-rf" });
});

test("wire then unwire restores the original file exactly (round-trip)", () => {
  const captureLeaf: LeafHook = {
    type: "command",
    command: "bun /home/me/regimen-feedback/hooks/capture-codex.ts",
    _regimen: { v: 1, role: "capture" },
  };
  const original = {
    hooks: {
      SessionStart: [{ hooks: [captureLeaf] }],
      PreToolUse: [
        {
          hooks: [
            captureLeaf,
            { type: "command", command: "bun /home/me/my-gate.ts" } as LeafHook,
          ],
        },
      ],
      Notification: [
        { hooks: [{ type: "command", command: "say hi" } as LeafHook] },
      ],
    },
    $schema: "https://example.com/codex-hooks.json",
  };
  const wired = planGateHooks(original, {
    clonePath: CLONE,
    harness: "codex",
    gates: [RM_RF, EM_DASH],
  }).hooks;
  const restored = planGateHooksRemoval(wired).hooks;
  expect(restored).toEqual(original);
});

test("a clonePath with a space is quoted as one argument and stays idempotent", () => {
  const spaced = "/tmp/clone path/regimen";
  const first = planGateHooks(undefined, {
    clonePath: spaced,
    harness: "codex",
    gates: [RM_RF, EM_DASH, INLINE],
  });

  // (a) Each command string quotes the path so it is a single shell argument:
  // the whole "<clonePath>/<script>" is wrapped in double quotes, so a space in
  // the path does not split the command into two arguments.
  const commands = leavesOn(first, "PreToolUse")
    .filter(isGateLeaf)
    .map((l) => l.command);
  expect(commands).toEqual([
    `REGIMEN_HARNESS=codex bun "${spaced}/tests/fixtures/rm-rf-gate.ts"`,
    `REGIMEN_HARNESS=codex bun "${spaced}/gates/em-dash-gate.ts"`,
    `REGIMEN_HARNESS=codex bun "${spaced}/gates/inline-message-gate.ts"`,
  ]);

  // (b) A re-run still recognizes each gate by id, so nothing double-wires.
  const second = planGateHooks(first.hooks, {
    clonePath: spaced,
    harness: "codex",
    gates: [RM_RF, EM_DASH, INLINE],
  });
  expect(second.added).toEqual([]);
  const ids = leavesOn(second, "PreToolUse")
    .filter(isGateLeaf)
    .map((l) => l._regimen?.id);
  expect(ids).toEqual(["rm-rf", "em-dash", "inline-message"]);
});

test("a relative clonePath is rejected (it would produce a broken hook command)", () => {
  expect(() =>
    planGateHooks(undefined, {
      clonePath: "regimen",
      harness: "codex",
      gates: [],
    }),
  ).toThrow(/absolute/);
});

test("a clonePath with characters special inside double quotes is rejected (injection)", () => {
  // Each path is interpolated INSIDE double quotes in a POSIX shell command, so
  // these are the real break-out / injection vectors: $ (substitution), ` `
  // (command substitution), " (closes the quote), \ (escape), and control chars
  // such as a newline. Every one must make the planner fail loud.
  for (const unsafe of [
    "/tmp/$(touch pwned)/repo",
    "/tmp/`touch pwned`/repo",
    '/tmp/"; rm -rf ~; "/repo',
    "/tmp/back\\slash/repo",
    "/tmp/new\nline/repo",
  ]) {
    expect(() =>
      planGateHooks(undefined, {
        clonePath: unsafe,
        harness: "codex",
        gates: [RM_RF],
      }),
    ).toThrow();
  }
});

test("a clonePath with characters literal inside double quotes is accepted and stays quoted", () => {
  // Space, single quote, and parentheses are all literal inside double quotes
  // and appear in real directory names, so they must NOT be rejected, and the
  // produced command keeps the path wrapped in one pair of double quotes.
  const safe = "/tmp/john's Backup (old)/regimen";
  const plan = planGateHooks(undefined, {
    clonePath: safe,
    harness: "codex",
    gates: [RM_RF],
  });
  const command = leavesOn(plan, "PreToolUse").filter(isGateLeaf)[0]?.command;
  expect(command).toBe(
    `REGIMEN_HARNESS=codex bun "${safe}/tests/fixtures/rm-rf-gate.ts"`,
  );
});

test("a structurally malformed existing file is refused, not silently rewritten", () => {
  expect(() =>
    planGateHooks({ hooks: "nope" } as unknown as undefined, {
      clonePath: CLONE,
      harness: "codex",
      gates: [],
    }),
  ).toThrow(/hooks/);
  expect(() =>
    planGateHooks(
      { hooks: { PreToolUse: [{ notHooks: [] }] } } as unknown as undefined,
      { clonePath: CLONE, harness: "codex", gates: [] },
    ),
  ).toThrow(/PreToolUse/);
});
