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
import {
  type Harness,
  harnessContract,
  type HooksFormat,
} from "@regimen/shared";
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

/**
 * A parsed Copilot hooks file (`versioned-command-leaves` format): a top-level
 * `version` plus an events map whose values are FLAT leaf arrays, with no
 * matcher-group wrapper. The structural divergence from `HooksFile` is exactly
 * this: events to `LeafHook[]` directly rather than to `MatcherGroup[]`, plus the
 * required `version`. The gate leaf identity, marker, and command are the same as
 * the nested format. Mirrors Feedback's capture-side `VersionedHooksFile`.
 */
export interface VersionedHooksFile {
  version?: number;
  hooks?: Record<string, LeafHook[]>;
  [key: string]: unknown;
}

/**
 * The per-harness gate-wiring profile: the divergences a gate install must honor
 * for a harness's pre-tool boundary to actually fire, beyond the structural
 * `format` the shared contract already carries. `preToolEvent` is the harness's
 * own pre-tool hook event name (the gate boundary): `PreToolUse` for Claude and
 * Codex, `preToolUse` for Copilot, `BeforeTool` for Gemini (see
 * docs/harness-divergences.md). `needsNameMatcher` is set for the one harness
 * (Gemini) whose nested hook groups must each carry a `name` and a `matcher` to
 * fire, per ADR-0011. These are enforcement's own gate facts, the analog of
 * Feedback's capture descriptor, kept here rather than in the shared contract so
 * the shared, cross-instrument data stays format-only.
 */
interface GateProfile {
  readonly preToolEvent: string;
  readonly needsNameMatcher: boolean;
}

const GATE_PROFILES: Partial<Record<Harness, GateProfile>> = {
  claude: { preToolEvent: "PreToolUse", needsNameMatcher: false },
  codex: { preToolEvent: "PreToolUse", needsNameMatcher: false },
  copilot: { preToolEvent: "preToolUse", needsNameMatcher: false },
  gemini: { preToolEvent: "BeforeTool", needsNameMatcher: true },
};

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
 * Refuse a structurally malformed Copilot-format file rather than rewriting it: a
 * present-but-non-object `hooks`, or an event whose value is not a flat array. The
 * versioned format has no matcher-group wrapper, so there is no group `hooks`
 * array to validate. The error names the offending path.
 */
function assertVersionedWellFormed(
  existing: VersionedHooksFile | undefined,
): void {
  if (existing?.hooks === undefined) return;
  const { hooks } = existing;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("hooks.json: `hooks` must be an object");
  }
  for (const [event, leaves] of Object.entries(hooks)) {
    if (!Array.isArray(leaves)) {
      throw new Error(`hooks.json: hooks.${event} must be an array`);
    }
  }
}

/** The union of the already-wired gate ids and the caller's, in catalog order. */
function desiredGateIds(
  existingGateIds: ReadonlyArray<GateId>,
  requested: ReadonlyArray<GateId>,
): GateId[] {
  return GATE_COMMANDS.map((g) => g.id).filter(
    (id) => existingGateIds.includes(id) || requested.includes(id),
  );
}

/**
 * The deduped gate leaves to wire and the added/unchanged report, given the gate
 * ids already present on the event. Deduped by gate id (union, catalog order) and
 * by script basename (two ids resolving to the same script file would double-wire
 * one gate). Format-independent: the same leaves are wrapped differently by the
 * nested and versioned writers.
 */
function buildGateLeaves(
  existingGateIds: ReadonlyArray<GateId>,
  ctx: GateContext,
  event: string,
): { gateLeaves: LeafHook[]; added: GateChange[]; unchanged: GateChange[] } {
  const added: GateChange[] = [];
  const unchanged: GateChange[] = [];
  const seenBasenames = new Set<string>();
  const gateLeaves: LeafHook[] = [];
  for (const id of desiredGateIds(existingGateIds, ctx.gates)) {
    const leaf = gateLeaf(id, ctx.clonePath, ctx.harness);
    const name = commandBasename(leaf.command);
    if (seenBasenames.has(name)) continue;
    seenBasenames.add(name);
    gateLeaves.push(leaf);
    (existingGateIds.includes(id) ? unchanged : added).push({ event, id });
  }
  return { gateLeaves, added, unchanged };
}

/**
 * Wire gates into a `nested-matcher-groups` file (Claude, Codex, Gemini) on the
 * harness's pre-tool event. Gates are appended in one group AFTER any existing
 * capture leaf or user group. Gemini's nested group additionally carries a `name`
 * and a `matcher` (per ADR-0011, a group without them does not fire); Claude and
 * Codex emit a bare `{ hooks }` group, unchanged.
 */
function planNestedGateHooks(
  existing: HooksFile | undefined,
  ctx: GateContext,
  profile: GateProfile,
): WirePlan {
  assertWellFormed(existing);
  const event = profile.preToolEvent;
  const base: HooksFile = existing ? structuredClone(existing) : {};
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;

  const groups = hooksMap[event] ?? [];
  const existingGateIds = groups
    .flatMap((g) => g.hooks)
    .filter(isGateLeaf)
    .map((l) => l._regimen?.id)
    .filter((id): id is GateId => id !== undefined);

  // The user's groups and any capture leaf are preserved verbatim by stripping
  // only gate leaves; the fresh gate group is appended after them.
  const preserved = stripGates(groups);
  const { gateLeaves, added, unchanged } = buildGateLeaves(
    existingGateIds,
    ctx,
    event,
  );

  const gateGroup: MatcherGroup = profile.needsNameMatcher
    ? { name: `regimen-gate-${event}`, matcher: "*", hooks: gateLeaves }
    : { hooks: gateLeaves };
  hooksMap[event] =
    gateLeaves.length > 0 ? [...preserved, gateGroup] : preserved;
  if (hooksMap[event].length === 0) delete hooksMap[event];

  return { hooks: base, added, unchanged };
}

/**
 * Wire gates into a `versioned-command-leaves` file (Copilot): a top-level
 * `version` plus an events map of FLAT leaf arrays (no matcher-group wrapper).
 * Gates are appended after the user's leaves on the harness's pre-tool event,
 * preserving the user's leaves and any foreign capture leaf.
 */
function planVersionedGateHooks(
  existing: VersionedHooksFile | undefined,
  ctx: GateContext,
  profile: GateProfile,
): WirePlan {
  assertVersionedWellFormed(existing);
  const event = profile.preToolEvent;
  const base: VersionedHooksFile = existing ? structuredClone(existing) : {};
  base.version = base.version ?? 1;
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;

  const leaves = hooksMap[event] ?? [];
  const existingGateIds = leaves
    .filter(isGateLeaf)
    .map((l) => l._regimen?.id)
    .filter((id): id is GateId => id !== undefined);

  // Preserve the user's leaves and any foreign capture leaf by stripping only
  // gate leaves; the fresh gate leaves are appended flat after them.
  const preserved = leaves.filter((l) => !isGateLeaf(l));
  const { gateLeaves, added, unchanged } = buildGateLeaves(
    existingGateIds,
    ctx,
    event,
  );

  hooksMap[event] = [...preserved, ...gateLeaves];
  if (hooksMap[event].length === 0) delete hooksMap[event];

  return { hooks: base as HooksFile, added, unchanged };
}

/**
 * Merge Enforcement's selected gates into a fresh-or-existing file on the
 * harness's pre-tool event, selecting the on-disk shape from the harness's gate
 * profile and the shared contract's hooks format. Surgical and additive: it
 * touches only gate leaves, appends its gates AFTER any existing capture leaf or
 * user hook, dedups by gate id and by script basename, and a plain re-run never
 * drops a gate opted into earlier. Throws on a relative clonePath, a shell-unsafe
 * clonePath, a malformed existing file, an unknown gate id, or an unregistered
 * harness.
 */
export function planGateHooks(
  existing: HooksFile | VersionedHooksFile | undefined,
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
  const contract = harnessContract(ctx.harness);
  if (contract === undefined) {
    throw new Error(`no contract registered for harness: ${ctx.harness}`);
  }
  const profile = GATE_PROFILES[ctx.harness];
  if (profile === undefined) {
    throw new Error(`no gate profile registered for harness: ${ctx.harness}`);
  }
  if (contract.hooksFile.format === "versioned-command-leaves") {
    return planVersionedGateHooks(
      existing as VersionedHooksFile | undefined,
      ctx,
      profile,
    );
  }
  return planNestedGateHooks(existing as HooksFile | undefined, ctx, profile);
}

/**
 * Remove exactly Enforcement's gate leaves from a Copilot-format file, leaving
 * the user's leaves, any foreign capture leaf, and the top-level `version` intact.
 * An event left with no leaves after the strip is pruned, mirroring the nested
 * path.
 */
function planVersionedGateHooksRemoval(
  existing: VersionedHooksFile | undefined,
): UnwirePlan {
  assertVersionedWellFormed(existing);
  const base: VersionedHooksFile = existing ? structuredClone(existing) : {};
  const removed: GateChange[] = [];
  const hooksMap = base.hooks;
  if (hooksMap === undefined) return { hooks: base as HooksFile, removed };

  for (const [event, leaves] of Object.entries(hooksMap)) {
    for (const leaf of leaves) {
      if (!isGateLeaf(leaf)) continue;
      const id = leaf._regimen?.id;
      if (id !== undefined) removed.push({ event, id });
    }
    const kept = leaves.filter((l) => !isGateLeaf(l));
    if (kept.length > 0) hooksMap[event] = kept;
    else delete hooksMap[event];
  }
  return { hooks: base as HooksFile, removed };
}

/**
 * Remove exactly Enforcement's gate entries; leave the user's hooks, any foreign
 * capture leaf, and (Gemini) a group's `name`/`matcher` on a surviving group
 * intact. The `format` selects the on-disk structure to strip, defaulting to
 * `nested-matcher-groups` so the three nested harnesses' callers are unchanged;
 * Copilot's `versioned-command-leaves` is passed explicitly.
 */
export function planGateHooksRemoval(
  existing: HooksFile | VersionedHooksFile | undefined,
  format: HooksFormat = "nested-matcher-groups",
): UnwirePlan {
  if (format === "versioned-command-leaves") {
    return planVersionedGateHooksRemoval(
      existing as VersionedHooksFile | undefined,
    );
  }
  const nested = existing as HooksFile | undefined;
  assertWellFormed(nested);
  const base: HooksFile = nested ? structuredClone(nested) : {};
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
