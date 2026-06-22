/**
 * The harness hooks-file wiring module (pure, capture-only). Exercised directly:
 * each test passes a parsed hooks file object (or undefined for a fresh file)
 * and asserts on the returned object, the same way install-skill.test.ts drives
 * planSkillInstall. No filesystem.
 *
 * The events, producer script, and leaf marker are sourced from the harness
 * descriptor, so the planner is data-driven and a new harness flows through
 * without editing it.
 *
 * Feedback owns only `role:"capture"` leaves; the separate regimen-enforcement
 * repo owns `role:"gate"` leaves in the same hooks file. The recognizer is
 * scoped to capture so a foreign gate leaf is preserved verbatim.
 */
import { expect, test } from "bun:test";
import {
  captureCommand,
  isRegimenLeaf,
  type LeafHook,
  planCaptureHooks,
  planCaptureHooksRemoval,
  type WireContext,
} from "../src/cli/install/capture-hooks.ts";
import { harnessDescriptor } from "../src/harness/descriptor.ts";

const DESCRIPTOR = harnessDescriptor("codex");
if (DESCRIPTOR === undefined) throw new Error("no codex descriptor registered");

const CLONE = "/home/me/regimen-feedback";
const CTX: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
const CAPTURE_EVENTS = DESCRIPTOR.capture.events;

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

test("a fresh file wires the capture hook onto all five events, each marked", () => {
  const plan = planCaptureHooks(undefined, CTX);

  for (const event of CAPTURE_EVENTS) {
    const groups = plan.hooks.hooks?.[event];
    expect(groups).toBeDefined();
    const captureLeaves = (groups ?? [])
      .flatMap((g) => g.hooks)
      .filter((h) => h._regimen?.role === "capture");
    expect(captureLeaves).toHaveLength(1);
    expect(captureLeaves[0]?.type).toBe("command");
    expect(captureLeaves[0]?.command).toBe(
      `bun ${CLONE}/hooks/capture-codex.ts`,
    );
    expect(captureLeaves[0]?._regimen).toEqual({ v: 1, role: "capture" });
  }
});

test("a fresh file wires no gate leaves: capture-only", () => {
  const plan = planCaptureHooks(undefined, CTX);
  for (const event of CAPTURE_EVENTS) {
    const gates = leavesOn(plan, event).filter(
      (l) => l._regimen?.role === "gate",
    );
    expect(gates).toHaveLength(0);
  }
});

test("user hooks are preserved in place; Feedback's capture lands after", () => {
  const userGate: LeafHook = {
    type: "command",
    command: "bun /home/me/my-own-gate.ts",
  };
  const existing = {
    hooks: {
      PreToolUse: [{ hooks: [userGate] }],
      // An event Feedback does not touch, plus a top-level key, must survive.
      Notification: [
        { hooks: [{ type: "command", command: "say hi" } as LeafHook] },
      ],
    },
    $schema: "https://example.com/codex-hooks.json",
  };

  const plan = planCaptureHooks(existing, CTX);

  // The user's PreToolUse group stays first and byte-identical.
  const preGroups = (plan.hooks.hooks?.PreToolUse ?? []) as Array<{
    hooks: LeafHook[];
  }>;
  expect(preGroups[0]?.hooks[0]).toEqual(userGate);
  // Feedback's capture lands after, in its own appended group.
  const pre = leavesOn(plan, "PreToolUse");
  expect(pre[0]).toEqual(userGate);
  expect(pre.slice(1).map((l) => l._regimen)).toEqual([
    { v: 1, role: "capture" },
  ]);

  // The untouched event and the top-level key survive verbatim.
  expect(leavesOn(plan, "Notification")[0]?.command).toBe("say hi");
  expect(plan.hooks.$schema).toBe("https://example.com/codex-hooks.json");

  // The original input is not mutated.
  expect(existing.hooks.PreToolUse[0]?.hooks).toHaveLength(1);
});

test("a foreign enforcement gate leaf is preserved verbatim by the capture-only planner", () => {
  const gateLeaf: LeafHook = {
    type: "command",
    command: "bun /opt/regimen-enforcement/gates/rm-rf.ts",
    _regimen: { v: 1, role: "gate", id: "rm-rf" },
  };
  const existing = {
    hooks: {
      PreToolUse: [{ hooks: [gateLeaf] }],
    },
  };

  const plan = planCaptureHooks(existing, CTX);

  // The enforcement gate leaf survives untouched, ahead of Feedback's capture.
  const pre = leavesOn(plan, "PreToolUse");
  expect(pre[0]).toEqual(gateLeaf);
  expect(pre.slice(1).map((l) => l._regimen)).toEqual([
    { v: 1, role: "capture" },
  ]);
  // The plan reports only its own capture as added, never the foreign gate.
  expect(plan.added).not.toContainEqual(
    expect.objectContaining({ role: "gate" }),
  );

  // Removal leaves the enforcement gate leaf in place.
  const removal = planCaptureHooksRemoval(plan.hooks);
  expect(removal.hooks.hooks?.PreToolUse).toEqual([{ hooks: [gateLeaf] }]);
  expect(removal.removed).not.toContainEqual(
    expect.objectContaining({ role: "gate" }),
  );
});

test("re-applying the same wiring is idempotent: nothing added, no duplicates", () => {
  const first = planCaptureHooks(undefined, CTX);
  const second = planCaptureHooks(first.hooks, CTX);

  expect(second.added).toEqual([]);
  expect(second.hooks).toEqual(first.hooks);
  // Capture on five events was already present.
  expect(second.unchanged).toHaveLength(CAPTURE_EVENTS.length);
  // PreToolUse still has exactly one capture leaf, not two.
  const pre = leavesOn(second, "PreToolUse").filter((l) => l._regimen);
  expect(pre).toHaveLength(1);
});

test("a moved clone re-homes Feedback's commands in place without duplicating", () => {
  const first = planCaptureHooks(undefined, CTX);
  const moved = "/opt/regimen-feedback";
  const second = planCaptureHooks(first.hooks, {
    descriptor: DESCRIPTOR,
    clonePath: moved,
  });

  const pre = leavesOn(second, "PreToolUse").filter((l) => l._regimen);
  expect(pre).toHaveLength(1);
  expect(pre[0]?.command).toBe(`bun ${moved}/hooks/capture-codex.ts`);
});

test("a relative clonePath is rejected (it would produce a broken hook command)", () => {
  expect(() =>
    planCaptureHooks(undefined, {
      descriptor: DESCRIPTOR,
      clonePath: "regimen-feedback",
    }),
  ).toThrow(/absolute/);
});

test("a structurally malformed existing file is refused, not silently rewritten", () => {
  expect(() =>
    planCaptureHooks({ hooks: "nope" } as unknown as undefined, CTX),
  ).toThrow(/hooks/);
  expect(() =>
    planCaptureHooks(
      { hooks: { PreToolUse: [{ notHooks: [] }] } } as unknown as undefined,
      CTX,
    ),
  ).toThrow(/PreToolUse/);
});

test("isRegimenLeaf recognizes by marker, not by command string", () => {
  const marked: LeafHook = {
    type: "command",
    command: "bun /anywhere/hooks/capture-codex.ts",
    _regimen: { v: 1, role: "capture" },
  };
  // A user who happens to point at the same script, but with no marker.
  const userLookalike: LeafHook = {
    type: "command",
    command: "bun /home/me/regimen-feedback/hooks/capture-codex.ts",
  };
  expect(isRegimenLeaf(marked)).toBe(true);
  expect(isRegimenLeaf(userLookalike)).toBe(false);
});

test("removal strips exactly Feedback's entries, keeps the user's, and prunes emptied structure", () => {
  const userGate: LeafHook = {
    type: "command",
    command: "bun /home/me/my-own-gate.ts",
  };
  const userLeaf: LeafHook = { type: "command", command: "say hi" };
  const existing = {
    hooks: {
      PreToolUse: [{ hooks: [userGate] }],
      Notification: [{ hooks: [userLeaf] }],
    },
  };
  const wired = planCaptureHooks(existing, CTX).hooks;

  const plan = planCaptureHooksRemoval(wired);

  // PreToolUse keeps only the user's group; the Feedback group is gone.
  expect(plan.hooks.hooks?.PreToolUse).toEqual([{ hooks: [userGate] }]);
  // Events Feedback created are pruned entirely.
  expect(plan.hooks.hooks?.SessionStart).toBeUndefined();
  expect(plan.hooks.hooks?.PostToolUse).toBeUndefined();
  // The user's untouched event survives.
  expect(plan.hooks.hooks?.Notification).toEqual([{ hooks: [userLeaf] }]);
  // It reports what it removed: capture on each of the five events.
  expect(plan.removed).toHaveLength(CAPTURE_EVENTS.length);
});

test("wire then unwire restores the user's file exactly (round-trip)", () => {
  const userFile = {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: "bun /home/me/my-gate.ts" } as LeafHook,
          ],
        },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "echo hi" } as LeafHook] },
      ],
      Notification: [
        { hooks: [{ type: "command", command: "say hi" } as LeafHook] },
      ],
    },
    $schema: "https://example.com/codex-hooks.json",
  };
  const wired = planCaptureHooks(userFile, CTX).hooks;
  const restored = planCaptureHooksRemoval(wired).hooks;
  expect(restored).toEqual(userFile);
});

test("removal is a no-op on an empty or absent file", () => {
  expect(planCaptureHooksRemoval(undefined).removed).toEqual([]);
  const empty = planCaptureHooksRemoval({ hooks: {} });
  expect(empty.removed).toEqual([]);
  expect(empty.hooks).toEqual({ hooks: {} });
});

test("the plan is descriptor-driven: events and producer come from the descriptor", () => {
  const plan = planCaptureHooks(undefined, CTX);

  // The subscribed events are exactly the descriptor's, in its order.
  expect(Object.keys(plan.hooks.hooks ?? {})).toEqual([
    ...DESCRIPTOR.capture.events,
  ]);
  // Every wired command invokes the descriptor's producer script under the clone.
  for (const event of DESCRIPTOR.capture.events) {
    const capture = leavesOn(plan, event).filter(isRegimenLeaf);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.command).toBe(
      `bun ${CLONE}/${DESCRIPTOR.capture.producerScript}`,
    );
    expect(capture[0]?._regimen).toEqual(DESCRIPTOR.capture.leafMarker);
  }
});

test("a Windows-style clone path yields a forward-slash command, no backslashes", () => {
  // A clone on native Windows reports a backslash path. The harness fires the
  // hook through a POSIX-style shell that strips backslashes, so the command must
  // emit forward slashes only or bun receives a separator-less, unresolvable path.
  const command = captureCommand(
    "C:\\Users\\me\\regimen",
    "hooks/capture-codex.ts",
  );
  expect(command).toBe("bun C:/Users/me/regimen/hooks/capture-codex.ts");
  expect(command).not.toContain("\\");
});

test("an already forward-slashed clone path is unchanged (Linux/macOS no-op)", () => {
  expect(captureCommand("/home/me/regimen", "hooks/capture-codex.ts")).toBe(
    "bun /home/me/regimen/hooks/capture-codex.ts",
  );
});

test("a different harness descriptor flows through the planner unedited", () => {
  // A fabricated descriptor with different events, producer, and marker proves
  // the planner reads descriptor DATA: a new harness needs no planner change.
  const other: WireContext = {
    descriptor: {
      contract: DESCRIPTOR.contract,
      capture: {
        events: ["Boot", "Prompt", "Tick"],
        producerScript: "adapters/capture-other.ts",
        leafMarker: { v: 1, role: "capture" },
      },
      transcriptsSubdir: "transcripts",
    },
    clonePath: CLONE,
  };

  const plan = planCaptureHooks(undefined, other);

  expect(Object.keys(plan.hooks.hooks ?? {})).toEqual([
    "Boot",
    "Prompt",
    "Tick",
  ]);
  for (const event of ["Boot", "Prompt", "Tick"]) {
    const capture = leavesOn(plan, event).filter(isRegimenLeaf);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.command).toBe(`bun ${CLONE}/adapters/capture-other.ts`);
  }
});
