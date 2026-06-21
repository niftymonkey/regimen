/**
 * The harness hooks-file wiring module for the `versioned-command-leaves` format
 * (Copilot's shape), exercised directly through `planCaptureHooks` /
 * `planCaptureHooksRemoval` with a real Copilot descriptor. The nested-format
 * counterpart lives in install-capture-hooks.test.ts; this suite covers only the
 * structural divergence: a top-level `version`, and flat leaf arrays per event
 * with no matcher-group wrapper. The leaf identity, marker, and command are
 * shared across formats, so those facts are asserted the same way here.
 *
 * Feedback owns only `role:"capture"` leaves; the separate enforcement package
 * owns `role:"gate"` leaves in the same file. The recognizer is scoped to capture
 * so a foreign gate leaf is preserved verbatim.
 */
import { expect, test } from "bun:test";
import {
  type LeafHook,
  planCaptureHooks,
  planCaptureHooksRemoval,
  type VersionedHooksFile,
  type WireContext,
} from "../src/cli/install/capture-hooks.ts";
import { harnessDescriptor } from "../src/harness/descriptor.ts";

const DESCRIPTOR = harnessDescriptor("copilot");
if (DESCRIPTOR === undefined) {
  throw new Error("no copilot descriptor registered");
}

const CLONE = "/home/me/regimen-feedback";
const CTX: WireContext = { descriptor: DESCRIPTOR, clonePath: CLONE };
const CAPTURE_EVENTS = DESCRIPTOR.capture.events;
const COMMAND = `bun ${CLONE}/${DESCRIPTOR.capture.producerScript}`;

/** The leaf array on one event of a versioned file. */
function leavesOn(file: VersionedHooksFile, event: string): LeafHook[] {
  return file.hooks?.[event] ?? [];
}

test("the copilot descriptor declares the versioned-command-leaves format", () => {
  // Guards the precondition this whole suite rests on: if the contract row ever
  // changes Copilot's format, these tests no longer prove the versioned path.
  expect(DESCRIPTOR.contract.hooksFile.format).toBe("versioned-command-leaves");
});

test("a fresh file produces {version:1, hooks:{<each event>:[flat capture leaf]}}", () => {
  const plan = planCaptureHooks(undefined, CTX);
  const file = plan.hooks as VersionedHooksFile;

  expect(file.version).toBe(1);
  // Each event maps directly to a flat leaf array (no matcher-group wrapper).
  expect(Object.keys(file.hooks ?? {})).toEqual([...CAPTURE_EVENTS]);
  for (const event of CAPTURE_EVENTS) {
    const leaves = leavesOn(file, event);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toEqual({
      type: "command",
      command: COMMAND,
      _regimen: { v: 1, role: "capture" },
    });
  }
  expect(plan.added.map((c) => c.event)).toEqual([...CAPTURE_EVENTS]);
});

test("re-wiring is idempotent: nothing added, no duplicate capture leaves", () => {
  const first = planCaptureHooks(undefined, CTX);
  const second = planCaptureHooks(first.hooks, CTX);

  expect(second.added).toEqual([]);
  expect(second.unchanged).toHaveLength(CAPTURE_EVENTS.length);
  expect(second.hooks).toEqual(first.hooks);
  for (const event of CAPTURE_EVENTS) {
    const captures = leavesOn(second.hooks as VersionedHooksFile, event).filter(
      (l) => l._regimen?.role === "capture",
    );
    expect(captures).toHaveLength(1);
  }
});

test("a moved clone re-homes the command in place without duplicating", () => {
  const first = planCaptureHooks(undefined, CTX);
  const moved = "/opt/regimen-feedback";
  const second = planCaptureHooks(first.hooks, {
    descriptor: DESCRIPTOR,
    clonePath: moved,
  });

  const leaves = leavesOn(second.hooks as VersionedHooksFile, "preToolUse");
  const captures = leaves.filter((l) => l._regimen?.role === "capture");
  expect(captures).toHaveLength(1);
  expect(captures[0]?.command).toBe(
    `bun ${moved}/${DESCRIPTOR.capture.producerScript}`,
  );
});

test("a pre-existing user leaf is preserved; capture lands after it", () => {
  const userLeaf: LeafHook = {
    type: "command",
    command: "bun /home/me/my-own-hook.ts",
  };
  const existing: VersionedHooksFile = {
    version: 1,
    hooks: { preToolUse: [userLeaf] },
  };

  const plan = planCaptureHooks(existing, CTX);
  const pre = leavesOn(plan.hooks as VersionedHooksFile, "preToolUse");

  expect(pre[0]).toEqual(userLeaf);
  expect(pre.slice(1).map((l) => l._regimen)).toEqual([
    { v: 1, role: "capture" },
  ]);
  // The original input is not mutated.
  expect(existing.hooks?.preToolUse).toEqual([userLeaf]);
});

test("a foreign enforcement gate leaf is preserved verbatim", () => {
  const gateLeaf: LeafHook = {
    type: "command",
    command: "bun /opt/regimen-enforcement/gates/rm-rf.ts",
    _regimen: { v: 1, role: "gate", id: "rm-rf" },
  };
  const existing: VersionedHooksFile = {
    version: 1,
    hooks: { preToolUse: [gateLeaf] },
  };

  const plan = planCaptureHooks(existing, CTX);
  const pre = leavesOn(plan.hooks as VersionedHooksFile, "preToolUse");

  expect(pre[0]).toEqual(gateLeaf);
  expect(pre.slice(1).map((l) => l._regimen)).toEqual([
    { v: 1, role: "capture" },
  ]);
  expect(plan.added).not.toContainEqual(
    expect.objectContaining({ role: "gate" }),
  );
});

test("a missing version defaults to 1; an existing version is preserved", () => {
  const fresh = planCaptureHooks(undefined, CTX);
  expect((fresh.hooks as VersionedHooksFile).version).toBe(1);

  const existing: VersionedHooksFile = { version: 2, hooks: {} };
  const plan = planCaptureHooks(existing, CTX);
  expect((plan.hooks as VersionedHooksFile).version).toBe(2);
});

test("unwiring removes only capture leaves, keeping version and foreign leaves", () => {
  const userLeaf: LeafHook = {
    type: "command",
    command: "bun /home/me/my-own-hook.ts",
  };
  const gateLeaf: LeafHook = {
    type: "command",
    command: "bun /opt/regimen-enforcement/gates/rm-rf.ts",
    _regimen: { v: 1, role: "gate", id: "rm-rf" },
  };
  const existing: VersionedHooksFile = {
    version: 1,
    hooks: { preToolUse: [userLeaf], postToolUse: [gateLeaf] },
  };
  const wired = planCaptureHooks(existing, CTX).hooks;

  const removal = planCaptureHooksRemoval(wired, "versioned-command-leaves");
  const file = removal.hooks as VersionedHooksFile;

  // Version survives the round-trip.
  expect(file.version).toBe(1);
  // The user leaf and the foreign gate leaf are both preserved, capture gone.
  expect(file.hooks?.preToolUse).toEqual([userLeaf]);
  expect(file.hooks?.postToolUse).toEqual([gateLeaf]);
  // Events Feedback created (with only its own capture leaf) are pruned entirely.
  expect(file.hooks?.sessionStart).toBeUndefined();
  // It never reports removing a foreign gate.
  expect(removal.removed).not.toContainEqual(
    expect.objectContaining({ role: "gate" }),
  );
  expect(removal.removed.length).toBeGreaterThan(0);
});

test("wire then unwire restores the user's versioned file exactly (round-trip)", () => {
  const userFile: VersionedHooksFile = {
    version: 1,
    hooks: {
      preToolUse: [{ type: "command", command: "bun /home/me/my-gate.ts" }],
      sessionStart: [{ type: "command", command: "echo hi" }],
    },
  };
  const wired = planCaptureHooks(userFile, CTX).hooks;
  const restored = planCaptureHooksRemoval(wired, "versioned-command-leaves")
    .hooks as VersionedHooksFile;
  expect(restored).toEqual(userFile);
});
