/**
 * The shared, role-parameterized hooks-file merge engine: the one idempotent
 * marker-stamping planner both Regimen instruments wire through. Feedback's
 * capture install and Enforcement's gate install were near-clones of this engine
 * (same hooks-file types, same strip-and-rebuild merge, same `HooksFormat`
 * branch, same Gemini name+matcher quirk, same forward-slash path discipline);
 * they now both supply a ROLE descriptor and call `planHooks` / `planHooksRemoval`
 * here, so the merge logic lives in exactly one place.
 *
 * Pure (dependency category 1): it transforms a parsed hooks-file object and the
 * CLI does the file read/write. It branches on the contract's `HooksFormat`
 * (`nested-matcher-groups` wraps each leaf in a matcher-group;
 * `versioned-command-leaves` lists flat leaves under a top-level `version`) and
 * stamps each Regimen-owned leaf with the `_regimen` sentinel marker so a re-run
 * recognizes its own entries by identity, not by command string, and never
 * clobbers the other instrument's leaf or the user's own hooks.
 *
 * What differs between capture and gate is carried by the role: which leaves are
 * the role's own (the identity predicate), the events to wire, the fresh leaves a
 * given event receives (one capture leaf, or the deduped gate leaves), the
 * optional per-group decoration a harness needs to fire (Gemini, ADR-0011), and
 * how a wired entry is reported as a change. The engine owns everything else.
 */
import type { HooksFormat } from "../harness/contract.ts";

/**
 * The sentinel marker stamped on each Regimen-owned leaf hook. The harness reads
 * only `type` and `command`, so this sibling key rides along untouched and is the
 * path-independent identity used both to avoid duplicating on re-run and to remove
 * exactly Regimen's entries on uninstall. `role` distinguishes the two instruments
 * sharing one hooks file: Feedback writes `"capture"`, Enforcement writes `"gate"`
 * (whose leaves additionally carry the gate `id`).
 */
export interface RegimenMarker {
  readonly v: 1;
  readonly role: "capture" | "gate";
  readonly id?: string;
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
 * required `version`. The leaf identity, marker, and command are the same as the
 * nested format. Unknown top-level keys pass through.
 */
export interface VersionedHooksFile {
  version?: number;
  hooks?: Record<string, LeafHook[]>;
  [key: string]: unknown;
}

/**
 * The optional per-group decoration a `nested-matcher-groups` harness requires on
 * the role's group for the hook to fire (Gemini, ADR-0011: a group without a
 * `name` and a `matcher` does not fire headless). Absent (undefined) means a bare
 * `{ hooks }` group, the shape Claude and Codex fire on.
 */
export interface GroupDecoration {
  readonly name: string;
  readonly matcher: string;
}

/** The fresh leaves to write on one event, plus the changes to report for them. */
export interface BuiltLeaves<Change> {
  readonly leaves: LeafHook[];
  readonly added: Change[];
  readonly unchanged: Change[];
}

/**
 * A wiring role: everything the engine needs that differs between capture and
 * gate. The engine owns the hooks-file structure, the preserve-strip-append
 * merge, the format branch, idempotent pruning, and not mutating the input; the
 * role owns identity and the leaves themselves.
 *
 * `Change` is the per-entry report shape (capture reports `{ event, role }`, gate
 * reports `{ event, id }`), so the engine is generic over it.
 */
export interface WireRole<Change> {
  /**
   * True iff a leaf is one this role owns. Scoped to the role so a foreign leaf
   * (the other instrument's, or the user's own) is recognized as not-ours and
   * preserved verbatim by the strip-and-rebuild and removal logic.
   */
  isOwnLeaf(leaf: LeafHook): boolean;
  /** The events to wire on apply, in order (capture's event list, gate's one pre-tool event). */
  readonly events: readonly string[];
  /**
   * The fresh leaves this role writes on one event, given the role's own leaves
   * already present there (for dedup), plus the added/unchanged report. Format-
   * independent: the engine wraps the same leaves differently per format.
   */
  buildLeaves(event: string, existingOwn: LeafHook[]): BuiltLeaves<Change>;
  /**
   * The decoration the role's nested group carries on one event, or undefined for
   * a bare `{ hooks }` group. Ignored on the versioned format (which has no
   * matcher-group wrapper).
   */
  decorationFor(event: string): GroupDecoration | undefined;
  /**
   * The change to report for one of the role's own leaves being removed on one
   * event, or undefined when the leaf carries nothing reportable. Drives the
   * removal report.
   */
  removalChangeFor(event: string, leaf: LeafHook): Change | undefined;
}

export interface WirePlan<Change> {
  readonly hooks: HooksFile;
  readonly added: ReadonlyArray<Change>;
  readonly unchanged: ReadonlyArray<Change>;
}

export interface UnwirePlan<Change> {
  readonly hooks: HooksFile;
  readonly removed: ReadonlyArray<Change>;
}

/**
 * Refuse a structurally malformed existing nested file rather than silently
 * rewriting it: a present-but-non-object `hooks`, an event whose value is not an
 * array, or a matcher-group missing its `hooks` array. The error names the
 * offending path so the CLI can surface it.
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
 * Drop only the role's own leaves from a set of matcher-groups, then drop any
 * group those removals emptied. Foreign leaves, user groups, and the other
 * instrument's leaves all stay in place and in order. Shared by apply (which
 * strips before re-adding the role's fresh group) and removal (which strips for
 * good).
 */
function stripOwn<Change>(
  groups: MatcherGroup[],
  role: WireRole<Change>,
): MatcherGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((l) => !role.isOwnLeaf(l)) }))
    .filter((g) => g.hooks.length > 0);
}

/**
 * Wrap the role's fresh leaves in one matcher-group on one event, carrying the
 * role's decoration (`name`/`matcher`) when the harness requires it for the group
 * to fire, else a bare `{ hooks }` group.
 */
function decoratedGroup<Change>(
  event: string,
  leaves: LeafHook[],
  role: WireRole<Change>,
): MatcherGroup {
  const decoration = role.decorationFor(event);
  if (decoration === undefined) return { hooks: leaves };
  return { name: decoration.name, matcher: decoration.matcher, hooks: leaves };
}

function planNestedHooks<Change>(
  existing: HooksFile | undefined,
  role: WireRole<Change>,
): WirePlan<Change> {
  assertWellFormed(existing);
  const base: HooksFile = existing ? structuredClone(existing) : {};
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;
  const added: Change[] = [];
  const unchanged: Change[] = [];

  for (const event of role.events) {
    const groups = hooksMap[event] ?? [];
    const existingOwn = groups.flatMap((g) => g.hooks).filter(role.isOwnLeaf);
    const preserved = stripOwn(groups, role);
    const built = role.buildLeaves(event, existingOwn);
    added.push(...built.added);
    unchanged.push(...built.unchanged);
    hooksMap[event] =
      built.leaves.length > 0
        ? [...preserved, decoratedGroup(event, built.leaves, role)]
        : preserved;
    if (hooksMap[event].length === 0) delete hooksMap[event];
  }
  return { hooks: base, added, unchanged };
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

function planVersionedHooks<Change>(
  existing: VersionedHooksFile | undefined,
  role: WireRole<Change>,
): WirePlan<Change> {
  assertVersionedWellFormed(existing);
  const base: VersionedHooksFile = existing ? structuredClone(existing) : {};
  base.version = base.version ?? 1;
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;
  const added: Change[] = [];
  const unchanged: Change[] = [];

  for (const event of role.events) {
    const leaves = hooksMap[event] ?? [];
    const existingOwn = leaves.filter(role.isOwnLeaf);
    const preserved = leaves.filter((l) => !role.isOwnLeaf(l));
    const built = role.buildLeaves(event, existingOwn);
    added.push(...built.added);
    unchanged.push(...built.unchanged);
    hooksMap[event] = [...preserved, ...built.leaves];
    if (hooksMap[event].length === 0) delete hooksMap[event];
  }
  return { hooks: base as HooksFile, added, unchanged };
}

export function planHooks<Change>(
  existing: HooksFile | VersionedHooksFile | undefined,
  role: WireRole<Change>,
  format: HooksFormat,
): WirePlan<Change> {
  if (format === "versioned-command-leaves") {
    return planVersionedHooks(existing as VersionedHooksFile | undefined, role);
  }
  return planNestedHooks(existing as HooksFile | undefined, role);
}

function planNestedHooksRemoval<Change>(
  existing: HooksFile | undefined,
  role: WireRole<Change>,
): UnwirePlan<Change> {
  assertWellFormed(existing);
  const base: HooksFile = existing ? structuredClone(existing) : {};
  const removed: Change[] = [];
  const hooksMap = base.hooks;
  if (hooksMap === undefined) return { hooks: base, removed };

  for (const [event, groups] of Object.entries(hooksMap)) {
    for (const leaf of groups.flatMap((g) => g.hooks)) {
      if (!role.isOwnLeaf(leaf)) continue;
      const change = role.removalChangeFor(event, leaf);
      if (change !== undefined) removed.push(change);
    }
    const kept = stripOwn(groups, role);
    if (kept.length > 0) hooksMap[event] = kept;
    else delete hooksMap[event];
  }
  return { hooks: base, removed };
}

function planVersionedHooksRemoval<Change>(
  existing: VersionedHooksFile | undefined,
  role: WireRole<Change>,
): UnwirePlan<Change> {
  assertVersionedWellFormed(existing);
  const base: VersionedHooksFile = existing ? structuredClone(existing) : {};
  const removed: Change[] = [];
  const hooksMap = base.hooks;
  if (hooksMap === undefined) return { hooks: base as HooksFile, removed };

  for (const [event, leaves] of Object.entries(hooksMap)) {
    for (const leaf of leaves) {
      if (!role.isOwnLeaf(leaf)) continue;
      const change = role.removalChangeFor(event, leaf);
      if (change !== undefined) removed.push(change);
    }
    const kept = leaves.filter((l) => !role.isOwnLeaf(l));
    if (kept.length > 0) hooksMap[event] = kept;
    else delete hooksMap[event];
  }
  return { hooks: base as HooksFile, removed };
}

export function planHooksRemoval<Change>(
  existing: HooksFile | VersionedHooksFile | undefined,
  role: WireRole<Change>,
  format: HooksFormat,
): UnwirePlan<Change> {
  if (format === "versioned-command-leaves") {
    return planVersionedHooksRemoval(
      existing as VersionedHooksFile | undefined,
      role,
    );
  }
  return planNestedHooksRemoval(existing as HooksFile | undefined, role);
}
