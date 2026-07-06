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
  readonly hooks: HooksFile | VersionedHooksFile;
  readonly added: ReadonlyArray<Change>;
  readonly unchanged: ReadonlyArray<Change>;
}

export interface UnwirePlan<Change> {
  readonly hooks: HooksFile | VersionedHooksFile;
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
 * top-level `version` that is present but not a number, a present-but-non-object
 * `hooks`, or an event whose value is not a flat array. The versioned format has
 * no matcher-group wrapper, so there is no group `hooks` array to validate. A
 * non-numeric `version` would otherwise be carried forward verbatim into a
 * malformed output file, so it is refused here too. The error names the offending
 * path.
 */
function assertVersionedWellFormed(
  existing: VersionedHooksFile | undefined,
): void {
  if (existing === undefined) return;
  if (existing.version !== undefined && typeof existing.version !== "number") {
    throw new Error("hooks.json: `version` must be a number");
  }
  if (existing.hooks === undefined) return;
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
  return { hooks: base, added, unchanged };
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
  if (hooksMap === undefined) return { hooks: base, removed };

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
  return { hooks: base, removed };
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

/**
 * The interpreter words a hook command may lead with (or a path whose basename is
 * one of them): the leaf's real script is the first ABSOLUTE path token that
 * follows, never the interpreter itself. Lowercased and `.exe`-stripped before the
 * lookup so a Windows `bun.exe` still reads as the interpreter.
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "bun",
  "bash",
  "node",
  "sh",
]);

/** A leading `VAR=value` environment assignment, skipped before the interpreter. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a hook command into tokens on unquoted whitespace, treating a
 * double-quoted run as one token (so `"/abs/path with spaces/x.ts"` stays whole).
 * The rule of thumb the harnesses write to: double quotes group, nothing else is
 * special. Single quotes and escapes are not interpreted (no harness emits them).
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let inQuote = false;
  for (const ch of command) {
    if (ch === '"') {
      inQuote = !inQuote;
      started = true;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The basename's interpreter identity: `bun`/`bash`/`node`/`sh`, `.exe`-tolerant. */
function isInterpreterToken(token: string): boolean {
  const base = token.split(/[/\\]/).pop() ?? token;
  return INTERPRETERS.has(base.toLowerCase().replace(/\.exe$/, ""));
}

/** An absolute path token: POSIX `/abs` or a Windows drive root `C:/` or `C:\`. */
function isAbsolutePathToken(token: string): boolean {
  return token.startsWith("/") || /^[A-Za-z]:[/\\]/.test(token);
}

/**
 * The script path a hook command runs, or undefined when none can be extracted.
 * Tokenizes (double quotes grouping), skips leading `VAR=value` assignments and a
 * single interpreter word (`bun`/`bash`/`node`/`sh`, or a path to one), then
 * returns the first remaining ABSOLUTE path token. Undefined on uncertainty (no
 * absolute path token) so a caller never acts on a command it could not read.
 */
export function extractCommandPath(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i++;
  if (i < tokens.length && isInterpreterToken(tokens[i]!)) i++;
  for (; i < tokens.length; i++) {
    if (isAbsolutePathToken(tokens[i]!)) return tokens[i];
  }
  return undefined;
}

/**
 * A dead Regimen-owned leaf: a leaf carrying a `_regimen` marker whose extracted
 * script path no longer exists. Carries what a report or a removal line needs (the
 * event, the marker role and id, the command).
 */
export interface DeadLeaf {
  readonly event: string;
  readonly role: RegimenMarker["role"];
  readonly id?: string;
  readonly command: string;
}

/** What {@link planDeadLeafRemoval} needs from the outside: on-disk existence and the clone roots. */
export interface PruneContext {
  /** True iff the leaf's extracted script path exists on disk. */
  readonly scriptExists: (path: string) => boolean;
  /**
   * The Regimen clone roots a dead marked leaf must sit under to be auto-removed
   * (the manifest's recorded clone before the update restamps it, and the current
   * clone). A dead marked leaf outside all of them is reported, never removed.
   */
  readonly clonePaths: readonly string[];
}

/**
 * The two-tier prune plan: `removed` are the dead marked leaves proven to sit
 * inside a Regimen clone (safe to auto-remove); `reported` are dead marked leaves
 * outside every known clone (an engineer's own gate on a moved or unavailable
 * path), surfaced but never removed. `hooks` is the input with only the `removed`
 * leaves stripped and any group they emptied pruned.
 */
export interface PrunePlan {
  readonly hooks: HooksFile | VersionedHooksFile;
  readonly removed: ReadonlyArray<DeadLeaf>;
  readonly reported: ReadonlyArray<DeadLeaf>;
}

/**
 * The extracted script path of a marked leaf whose script is missing, or
 * undefined when the leaf is unmarked, has no extractable path, or the path still
 * exists. Unmarked leaves and leaves whose command cannot be read are never dead,
 * so a caller never removes or reports them.
 */
function deadScriptPath(
  leaf: LeafHook,
  scriptExists: (path: string) => boolean,
): string | undefined {
  if (leaf._regimen === undefined) return undefined;
  const path = extractCommandPath(leaf.command);
  if (path === undefined) return undefined;
  return scriptExists(path) ? undefined : path;
}

/** Project a marked leaf onto the {@link DeadLeaf} report shape for one event. */
function toDeadLeaf(event: string, leaf: LeafHook): DeadLeaf | undefined {
  const marker = leaf._regimen;
  if (marker === undefined) return undefined;
  return {
    event,
    role: marker.role,
    command: leaf.command,
    ...(marker.id === undefined ? {} : { id: marker.id }),
  };
}

/** Path segments, separator-normalized, with empty and `.` segments dropped. */
function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== ".");
}

/**
 * True iff `child` lies at or under `parent` by whole path segments, so a clone
 * `/tmp/x/regimen` contains `/tmp/x/regimen/gate.ts` but NOT the sibling
 * `/tmp/x/regimen-other/gate.ts` (a raw string prefix would wrongly match).
 */
function isPathInside(child: string, parent: string): boolean {
  const c = pathSegments(child);
  const p = pathSegments(parent);
  if (p.length === 0 || c.length < p.length) return false;
  return p.every((seg, i) => seg === c[i]);
}

/**
 * A prune role over dead marked leaves: `owns` selects which of them this pass
 * removes (inside-clone) or merely visits (outside-clone), given the leaf's dead
 * script path. The removal machinery then strips the owned leaves and prunes any
 * group they emptied, identically to a normal unwire.
 */
function deadLeafRole(
  ctx: PruneContext,
  owns: (deadPath: string) => boolean,
): WireRole<DeadLeaf> {
  return {
    isOwnLeaf: (leaf) => {
      const dead = deadScriptPath(leaf, ctx.scriptExists);
      return dead !== undefined && owns(dead);
    },
    events: [],
    buildLeaves: () => ({ leaves: [], added: [], unchanged: [] }),
    decorationFor: () => undefined,
    removalChangeFor: toDeadLeaf,
  };
}

/**
 * Plan the two-tier dead-leaf prune (ADR: `regimen update` prunes only what it can
 * prove it installed). A leaf is a removal candidate only when it carries a
 * `_regimen` marker AND its extracted script path is missing AND that path sits
 * inside one of `ctx.clonePaths`; such leaves are stripped from `hooks` and listed
 * in `removed`. A marked, dead leaf whose path is outside every clone is listed in
 * `reported` and left untouched. Unmarked leaves, live leaves, and leaves whose
 * command yields no path are never touched and never reported. Reuses the shared
 * removal planner for both format branches, so no format knowledge is duplicated.
 */
export function planDeadLeafRemoval(
  existing: HooksFile | VersionedHooksFile | undefined,
  format: HooksFormat,
  ctx: PruneContext,
): PrunePlan {
  const inside = (path: string): boolean =>
    ctx.clonePaths.some((clone) => isPathInside(path, clone));
  const removal = planHooksRemoval(existing, deadLeafRole(ctx, inside), format);
  const report = planHooksRemoval(
    existing,
    deadLeafRole(ctx, (path) => !inside(path)),
    format,
  );
  return {
    hooks: removal.hooks,
    removed: removal.removed,
    reported: report.removed,
  };
}
