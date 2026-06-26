/**
 * The shared, role-parameterized hooks-file merge engine (pure). Exercised
 * directly through `planHooks` / `planHooksRemoval` with two fabricated roles, a
 * single-leaf "alpha" role (the capture shape: one leaf per event) and a
 * multi-leaf "beta" role (the gate shape: several leaves on one event), across
 * both `HooksFormat`s. The instrument-specific roles (Feedback's capture,
 * Enforcement's gate) are thin wrappers over this engine and keep their own
 * end-to-end suites; this suite proves the engine itself preserves foreign
 * leaves, is idempotent, prunes emptied structure, applies the nested decoration,
 * and never mutates its input, for either role on either format.
 */
import { expect, test } from "bun:test";
import {
  type BuiltLeaves,
  type LeafHook,
  type MatcherGroup,
  planHooks,
  planHooksRemoval,
  type VersionedHooksFile,
  type WireRole,
} from "../src/install/hooks-engine.ts";

interface AlphaChange {
  readonly event: string;
  readonly role: "alpha";
}

/** A single-leaf role (capture-shaped): one leaf per event, no dedup, no decoration. */
function alphaRole(events: readonly string[]): WireRole<AlphaChange> {
  const leaf = (): LeafHook => ({
    type: "command",
    command: "run alpha",
    _regimen: { v: 1, role: "capture" },
  });
  return {
    isOwnLeaf: (l) => l._regimen?.role === "capture",
    events,
    buildLeaves(event, existingOwn): BuiltLeaves<AlphaChange> {
      const change: AlphaChange = { event, role: "alpha" };
      return existingOwn.length > 0
        ? { leaves: [leaf()], added: [], unchanged: [change] }
        : { leaves: [leaf()], added: [change], unchanged: [] };
    },
    decorationFor: () => undefined,
    removalChangeFor: (event) => ({ event, role: "alpha" }),
  };
}

interface BetaChange {
  readonly event: string;
  readonly id: string;
}

/** A multi-leaf role (gate-shaped): several leaves on one event, deduped by id. */
function betaRole(event: string, ids: readonly string[]): WireRole<BetaChange> {
  return {
    isOwnLeaf: (l) => l._regimen?.role === "gate",
    events: [event],
    buildLeaves(ev, existingOwn): BuiltLeaves<BetaChange> {
      const present = new Set(
        existingOwn.map((l) => l._regimen?.id).filter((id) => id !== undefined),
      );
      const wanted = [...present, ...ids.filter((id) => !present.has(id))];
      const leaves: LeafHook[] = wanted.map((id) => ({
        type: "command",
        command: `run ${id}`,
        _regimen: { v: 1, role: "gate", id },
      }));
      const added = ids
        .filter((id) => !present.has(id))
        .map((id) => ({ event: ev, id }));
      const unchanged = [...present].map((id) => ({ event: ev, id }));
      return { leaves, added, unchanged };
    },
    decorationFor: (ev) => ({ name: `beta-${ev}`, matcher: "*" }),
    removalChangeFor: (ev, leaf) => {
      const id = leaf._regimen?.id;
      return id === undefined ? undefined : { event: ev, id };
    },
  };
}

/** All leaf hooks across every group on one nested event, in order. */
function nestedLeaves(
  hooks: Record<string, unknown>,
  event: string,
): LeafHook[] {
  const groups = (hooks[event] ?? []) as MatcherGroup[];
  return groups.flatMap((g) => g.hooks);
}

test("nested: a fresh file wires the alpha role's leaf onto each event, each marked", () => {
  const plan = planHooks(
    undefined,
    alphaRole(["A", "B"]),
    "nested-matcher-groups",
  );

  expect(Object.keys(plan.hooks.hooks ?? {})).toEqual(["A", "B"]);
  for (const event of ["A", "B"]) {
    const leaves = nestedLeaves(plan.hooks.hooks ?? {}, event);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?._regimen).toEqual({ v: 1, role: "capture" });
  }
  expect(plan.added.map((c) => c.event)).toEqual(["A", "B"]);
});

test("nested: a foreign leaf and a user group are preserved; the role's group lands after", () => {
  const foreign: LeafHook = {
    type: "command",
    command: "run gate",
    _regimen: { v: 1, role: "gate", id: "x" },
  };
  const userGroup: MatcherGroup = {
    hooks: [{ type: "command", command: "user hook" }],
    note: "user",
  };
  const existing = {
    hooks: { A: [userGroup, { hooks: [foreign] }] },
    $schema: "https://example.com/hooks.json",
  };

  const plan = planHooks(existing, alphaRole(["A"]), "nested-matcher-groups");

  const leaves = nestedLeaves(plan.hooks.hooks ?? {}, "A");
  expect(leaves[0]).toEqual(userGroup.hooks[0]!);
  expect(leaves[1]).toEqual(foreign);
  expect(leaves[2]?._regimen).toEqual({ v: 1, role: "capture" });
  // The top-level key and the original input are untouched.
  expect(plan.hooks.$schema).toBe("https://example.com/hooks.json");
  expect(existing.hooks.A).toHaveLength(2);
});

test("nested: re-applying the alpha role is idempotent, nothing added, no duplicate", () => {
  const first = planHooks(undefined, alphaRole(["A"]), "nested-matcher-groups");
  const second = planHooks(
    first.hooks,
    alphaRole(["A"]),
    "nested-matcher-groups",
  );

  expect(second.added).toEqual([]);
  expect(second.unchanged).toHaveLength(1);
  expect(second.hooks).toEqual(first.hooks);
  expect(
    nestedLeaves(second.hooks.hooks ?? {}, "A").filter((l) => l._regimen),
  ).toHaveLength(1);
});

test("nested: the beta role's multi-leaf group carries its decoration; a re-run is additive", () => {
  const first = planHooks(
    undefined,
    betaRole("Pre", ["x"]),
    "nested-matcher-groups",
  );
  const groups = (first.hooks.hooks?.Pre ?? []) as MatcherGroup[];
  // The role's group carries the decoration the harness needs to fire.
  expect(groups[0]?.name).toBe("beta-Pre");
  expect(groups[0]?.matcher).toBe("*");

  // A later run with a different id keeps the earlier one (union, deduped).
  const second = planHooks(
    first.hooks,
    betaRole("Pre", ["y"]),
    "nested-matcher-groups",
  );
  const ids = nestedLeaves(second.hooks.hooks ?? {}, "Pre").map(
    (l) => l._regimen?.id,
  );
  expect(ids).toEqual(["x", "y"]);
  expect(second.added).toEqual([{ event: "Pre", id: "y" }]);
  expect(second.unchanged).toEqual([{ event: "Pre", id: "x" }]);
});

test("nested: removal strips exactly the role's leaves, keeps foreign, prunes emptied", () => {
  const userGroup: MatcherGroup = {
    hooks: [{ type: "command", command: "user" }],
  };
  const existing = { hooks: { A: [userGroup] } };
  const wired = planHooks(
    existing,
    alphaRole(["A", "B"]),
    "nested-matcher-groups",
  ).hooks;

  const removal = planHooksRemoval(
    wired,
    alphaRole(["A", "B"]),
    "nested-matcher-groups",
  );

  // A keeps only the user's group; B (role-created) is pruned entirely.
  expect(removal.hooks.hooks?.A).toEqual([userGroup]);
  expect(removal.hooks.hooks?.B).toBeUndefined();
  expect(removal.removed).toEqual([
    { event: "A", role: "alpha" },
    { event: "B", role: "alpha" },
  ]);
});

test("versioned: flat leaves under a top-level version, decoration ignored, foreign kept", () => {
  const foreign: LeafHook = {
    type: "command",
    command: "run capture",
    _regimen: { v: 1, role: "capture" },
  };
  const existing: VersionedHooksFile = {
    version: 2,
    hooks: { Pre: [foreign] },
  };

  const plan = planHooks(
    existing,
    betaRole("Pre", ["x"]),
    "versioned-command-leaves",
  );
  const file = plan.hooks as VersionedHooksFile;

  // The version is preserved, and the leaves are FLAT (no matcher-group wrapper,
  // so the role's decoration does not apply).
  expect(file.version).toBe(2);
  const leaves = file.hooks?.Pre ?? [];
  expect(leaves[0]).toEqual(foreign);
  expect(leaves[1]?._regimen).toEqual({ v: 1, role: "gate", id: "x" });
  expect((leaves[1] as { hooks?: unknown }).hooks).toBeUndefined();
});

test("versioned: a fresh file defaults version to 1; removal keeps version and foreign", () => {
  const fresh = planHooks(
    undefined,
    alphaRole(["Pre"]),
    "versioned-command-leaves",
  );
  expect((fresh.hooks as VersionedHooksFile).version).toBe(1);

  const foreign: LeafHook = {
    type: "command",
    command: "run gate",
    _regimen: { v: 1, role: "gate", id: "z" },
  };
  const wired = planHooks(
    { version: 1, hooks: { Pre: [foreign] } },
    alphaRole(["Pre"]),
    "versioned-command-leaves",
  ).hooks;
  const removal = planHooksRemoval(
    wired,
    alphaRole(["Pre"]),
    "versioned-command-leaves",
  );
  const file = removal.hooks as VersionedHooksFile;

  expect(file.version).toBe(1);
  expect(file.hooks?.Pre).toEqual([foreign]);
  expect(removal.removed).toEqual([{ event: "Pre", role: "alpha" }]);
});
