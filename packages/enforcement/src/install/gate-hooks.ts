/**
 * The gate-scoped `hooks.json` planner for the contract's nested-matcher-groups
 * format (events to matcher-groups to command leaves). Pure: it transforms a
 * parsed hooks.json object and the CLI does the file read/write. The wired
 * command carries the resolved harness, so the planner is not bound to one CLI.
 *
 * Scoped clone of Feedback's capture+gate planner, GATES ONLY. Enforcement owns
 * discipline gates, not the capture hook, so this planner touches only
 * `role:"gate"` leaves: it preserves a `role:"capture"` leaf (wired by Feedback's
 * own installer) and the user's own hooks verbatim. Regimen recognizes its own
 * gate entries by a sentinel marker (`_regimen`) stamped on each leaf, not by the
 * command string, so recognition survives a moved clone.
 */
import { basename, isAbsolute } from "node:path";
import type { Harness } from "@regimen/shared";
import { assertSafeClonePath } from "./clone-path.ts";
import { GATE_COMMANDS, type GateId } from "./gate-commands.ts";

export type { GateId } from "./gate-commands.ts";
export { assertSafeClonePath } from "./clone-path.ts";

/** The sentinel marker stamped on each Enforcement-owned gate leaf. */
export interface RegimenMarker {
  readonly v: 1;
  readonly role: "capture" | "gate";
  readonly id?: GateId;
}

/** One command hook leaf in a matcher-group. Unknown keys pass through. */
export interface LeafHook {
  type: "command";
  command: string;
  _regimen?: RegimenMarker;
  [key: string]: unknown;
}

/** One matcher-group: an ordered list of leaf hooks. Unknown keys pass through. */
export interface MatcherGroup {
  hooks: LeafHook[];
  [key: string]: unknown;
}

/** A parsed hooks.json. Unknown top-level keys pass through. */
export interface HooksFile {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

export interface GateContext {
  /** The clone's absolute path. Every command string is rooted here. */
  readonly clonePath: string;
  /** The harness the gates are wired for; shell gates carry it as REGIMEN_HARNESS. */
  readonly harness: Harness;
  /** Which gates to wire onto PreToolUse. */
  readonly gates: ReadonlyArray<GateId>;
}

/** One gate-entry change, for the CLI to report. */
export interface GateChange {
  readonly event: string;
  readonly id: GateId;
}

export interface WirePlan {
  readonly hooks: HooksFile;
  readonly added: ReadonlyArray<GateChange>;
  readonly unchanged: ReadonlyArray<GateChange>;
}

export interface UnwirePlan {
  readonly hooks: HooksFile;
  readonly removed: ReadonlyArray<GateChange>;
}

/** The event every gate is wired onto. */
const GATE_EVENT = "PreToolUse";

/** True iff a leaf hook is a gate Enforcement owns (marker role "gate"). */
export function isGateLeaf(leaf: LeafHook): boolean {
  return leaf._regimen?.role === "gate";
}

/**
 * The script path a gate command points at, for dedup by basename. Command
 * strings quote the interpolated path (so a space in the clone path stays one
 * shell argument), so the path is the contents of the last double-quoted segment
 * when present; otherwise it is the last whitespace-separated token. Either way
 * any surrounding double quotes are stripped before basename so a quoted path
 * does not yield a basename with a trailing quote or a split-on-space fragment.
 */
function commandBasename(command: string): string {
  const [, quotedPath] = command.match(/"([^"]*)"(?!.*")/) ?? [];
  const token =
    quotedPath ?? (command.split(/\s+/).pop() ?? command).replace(/^"|"$/g, "");
  return basename(token);
}

/** A fresh gate leaf for the given gate id, clone, and harness. */
function gateLeaf(id: GateId, clonePath: string, harness: Harness): LeafHook {
  const spec = GATE_COMMANDS.find((g) => g.id === id);
  if (spec === undefined) throw new Error(`unknown gate id: ${id}`);
  return {
    type: "command",
    command: spec.command(clonePath, harness),
    _regimen: { v: 1, role: "gate", id },
  };
}

/**
 * Drop only Enforcement's own gate leaves from a set of matcher-groups, then
 * drop any group those removals emptied. A capture leaf, a user leaf, and a user
 * group all stay in place and in order. Shared by apply (which strips before
 * re-adding a fresh gate group) and removal (which strips for good).
 */
function stripGates(groups: MatcherGroup[]): MatcherGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((l) => !isGateLeaf(l)) }))
    .filter((g) => g.hooks.length > 0);
}

/**
 * Refuse a structurally malformed existing file rather than silently rewriting
 * it: a present-but-non-object `hooks`, an event whose value is not an array, or
 * a matcher-group missing its `hooks` array. The error names the offending path.
 */
function assertWellFormed(existing: HooksFile | undefined): void {
  if (existing?.hooks === undefined) return;
  const { hooks } = existing;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("hooks.json: `hooks` must be an object");
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`hooks.json: hooks.${event} must be an array`);
    }
    for (const group of groups) {
      if (!Array.isArray((group as MatcherGroup)?.hooks)) {
        throw new Error(
          `hooks.json: a group on hooks.${event} is missing its hooks array`,
        );
      }
    }
  }
}

/**
 * Merge Enforcement's selected gates into a fresh-or-existing file, on
 * PreToolUse only. Surgical and additive: it touches only gate leaves, appends
 * its gate group AFTER any existing capture leaf or user group, dedups by gate
 * id and by script basename, and a plain re-run never drops a gate opted into
 * earlier. Throws on a relative clonePath, a shell-unsafe clonePath, a malformed
 * existing file, or an unknown gate id.
 */
export function planGateHooks(
  existing: HooksFile | undefined,
  ctx: GateContext,
): WirePlan {
  if (!isAbsolute(ctx.clonePath)) {
    throw new Error(`clonePath must be absolute, got: ${ctx.clonePath}`);
  }
  assertSafeClonePath(ctx.clonePath);
  const known = new Set<string>(GATE_COMMANDS.map((g) => g.id));
  for (const id of ctx.gates) {
    if (!known.has(id)) throw new Error(`unknown gate id: ${id}`);
  }
  assertWellFormed(existing);
  const base: HooksFile = existing ? structuredClone(existing) : {};
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;
  const added: GateChange[] = [];
  const unchanged: GateChange[] = [];

  const groups = hooksMap[GATE_EVENT] ?? [];
  const existingGateIds = groups
    .flatMap((g) => g.hooks)
    .filter(isGateLeaf)
    .map((l) => l._regimen?.id)
    .filter((id): id is GateId => id !== undefined);

  // What this planner owns and rewrites: the user's groups and any capture leaf
  // are preserved verbatim by stripping only gate leaves.
  const preserved = stripGates(groups);

  // Additive and deduped by id: the gates wired are the union of what is already
  // wired and what the caller asked for, in catalog order, each id once.
  const desiredGateIds = GATE_COMMANDS.map((g) => g.id).filter(
    (id) => existingGateIds.includes(id) || ctx.gates.includes(id),
  );

  // Dedup by script basename too: two ids resolving to the same script file
  // would double-wire the same gate.
  const seenBasenames = new Set<string>();
  const gateLeaves: LeafHook[] = [];
  for (const id of desiredGateIds) {
    const leaf = gateLeaf(id, ctx.clonePath, ctx.harness);
    const name = commandBasename(leaf.command);
    if (seenBasenames.has(name)) continue;
    seenBasenames.add(name);
    gateLeaves.push(leaf);
    (existingGateIds.includes(id) ? unchanged : added).push({
      event: GATE_EVENT,
      id,
    });
  }

  hooksMap[GATE_EVENT] =
    gateLeaves.length > 0 ? [...preserved, { hooks: gateLeaves }] : preserved;
  if (hooksMap[GATE_EVENT].length === 0) delete hooksMap[GATE_EVENT];

  return { hooks: base, added, unchanged };
}

/** Remove exactly Enforcement's gate entries; leave everything else intact. */
export function planGateHooksRemoval(
  existing: HooksFile | undefined,
): UnwirePlan {
  assertWellFormed(existing);
  const base: HooksFile = existing ? structuredClone(existing) : {};
  const removed: GateChange[] = [];
  const hooksMap = base.hooks;
  if (hooksMap === undefined) return { hooks: base, removed };

  for (const [event, groups] of Object.entries(hooksMap)) {
    for (const leaf of groups.flatMap((g) => g.hooks)) {
      if (!isGateLeaf(leaf)) continue;
      const id = leaf._regimen?.id;
      if (id !== undefined) removed.push({ event, id });
    }
    const kept = stripGates(groups);
    if (kept.length > 0) hooksMap[event] = kept;
    else delete hooksMap[event];
  }
  return { hooks: base, removed };
}
