/**
 * The harness hooks-file wiring module: the one genuinely new piece of the
 * unified installer. Pure (dependency category 1): it transforms a parsed
 * hooks file object and the CLI does the file read/write, exactly like
 * `planInstall` and `planSkillInstall`.
 *
 * It wires Feedback's capture hook onto the harness events idempotently and
 * without clobbering the user's own hooks. The events to subscribe, the producer
 * script the command invokes, and the sentinel leaf marker all come from the
 * harness descriptor (data, not hardcoded), so a new harness flows through
 * without editing this planner. Feedback recognizes its own entries by the
 * descriptor's marker (`_regimen`) stamped on each leaf hook, not by the command
 * string, so recognition survives a moved clone. The marker is the identity used
 * both to avoid duplicating on re-run and to remove exactly Feedback's entries
 * on uninstall.
 *
 * Feedback owns only `role:"capture"` leaves. The enforcement package owns
 * `role:"gate"` leaves in the same hooks file, so this module's
 * recognizer is scoped to capture: it preserves a foreign enforcement gate leaf
 * (and the user's own hooks) verbatim, touching only capture leaves.
 */
import { isAbsolute, join } from "node:path";
import type { HooksFormat } from "@regimen/shared";
import type { HarnessDescriptor } from "../../harness/descriptor.ts";

/**
 * The sentinel marker stamped on each Regimen-owned leaf hook. The harness reads
 * only `type` and `command`, so this sibling key rides along untouched and is the
 * path-independent identity for dedup and removal. Feedback writes
 * `role:"capture"` (from the descriptor's leaf marker); `role:"gate"` belongs to
 * the enforcement package and is recognized here only so the detector can leave it
 * alone.
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

export interface WireContext {
  /** The harness descriptor: the events, producer script, and leaf marker. */
  readonly descriptor: HarnessDescriptor;
  /** The clone's absolute path. Every command string is rooted here. */
  readonly clonePath: string;
}

/** One capture-entry change, for the CLI to report. */
export interface WireChange {
  readonly event: string;
  readonly role: "capture";
}

/**
 * A wiring plan. `hooks` is the merged file object the CLI serializes back to
 * disk. It is typed as the nested `HooksFile` because that is the only shape with
 * matcher-group structure callers introspect directly; the Copilot
 * (`versioned-command-leaves`) path returns a structurally different
 * `VersionedHooksFile` here (flat leaves under a top-level `version`), which the
 * CLI serializes identically and Copilot-format tests narrow with a cast. The two
 * shapes are interchangeable to the serializer (both are JSON objects with an
 * events map), so the report fields below are format-agnostic.
 */
export interface WirePlan {
  readonly hooks: HooksFile;
  readonly added: ReadonlyArray<WireChange>;
  readonly unchanged: ReadonlyArray<WireChange>;
}

export interface UnwirePlan {
  readonly hooks: HooksFile;
  readonly removed: ReadonlyArray<WireChange>;
}

/**
 * True iff a leaf hook is a Feedback capture leaf (carries `role:"capture"`).
 * Scoped to capture so a foreign enforcement gate leaf (`role:"gate"`, owned by
 * the enforcement package in the same hooks.json) is not recognized here and is
 * therefore preserved verbatim by the strip-and-rebuild and removal logic.
 */
export function isRegimenLeaf(leaf: LeafHook): boolean {
  return leaf._regimen?.role === "capture";
}

/**
 * Drop Feedback's own capture leaves from a set of matcher-groups, then drop
 * any group that the removal emptied. User leaves, user groups, and any foreign
 * enforcement gate leaves stay in place and in order. Shared by apply (which
 * strips before re-adding a fresh capture group) and removal (which strips for
 * good).
 */
function stripRegimen(groups: MatcherGroup[]): MatcherGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((l) => !isRegimenLeaf(l)) }))
    .filter((g) => g.hooks.length > 0);
}

/** The capture hook command, rooted at the clone, from the descriptor's producer script. */
function captureCommand(clonePath: string, producerScript: string): string {
  return `bun ${join(clonePath, producerScript)}`;
}

/** A fresh capture leaf for the given clone, stamped with the descriptor's leaf marker. */
function captureLeaf(ctx: WireContext): LeafHook {
  return {
    type: "command",
    command: captureCommand(
      ctx.clonePath,
      ctx.descriptor.capture.producerScript,
    ),
    _regimen: ctx.descriptor.capture.leafMarker,
  };
}

/**
 * Refuse a structurally malformed existing file rather than silently rewriting
 * it: a present-but-non-object `hooks`, an event whose value is not an array,
 * or a matcher-group missing its `hooks` array. The error names the offending
 * path so the CLI can surface it.
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

/**
 * Merge Feedback's capture hook into a Copilot-format (`versioned-command-leaves`)
 * file: a top-level `version` plus an events map of FLAT leaf arrays.
 */
function planVersionedCaptureHooks(
  existing: VersionedHooksFile | undefined,
  ctx: WireContext,
): WirePlan {
  assertVersionedWellFormed(existing);
  const base: VersionedHooksFile = existing ? structuredClone(existing) : {};
  base.version = base.version ?? 1;
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;
  const added: WireChange[] = [];
  const unchanged: WireChange[] = [];

  for (const event of ctx.descriptor.capture.events) {
    const leaves = hooksMap[event] ?? [];
    const hadCapture = leaves.some(isRegimenLeaf);
    const userLeaves = leaves.filter((l) => !isRegimenLeaf(l));
    hooksMap[event] = [...userLeaves, captureLeaf(ctx)];
    (hadCapture ? unchanged : added).push({ event, role: "capture" });
  }
  return { hooks: base as HooksFile, added, unchanged };
}

/**
 * Remove Feedback's capture leaves from a Copilot-format file, leaving the user's
 * leaves, any foreign gate leaf, and the top-level `version` intact. An event left
 * with no leaves after the strip is pruned entirely, mirroring the nested path.
 */
function planVersionedCaptureHooksRemoval(
  existing: VersionedHooksFile | undefined,
): UnwirePlan {
  assertVersionedWellFormed(existing);
  const base: VersionedHooksFile = existing ? structuredClone(existing) : {};
  const removed: WireChange[] = [];
  const hooksMap = base.hooks;
  if (hooksMap === undefined) return { hooks: base as HooksFile, removed };

  for (const [event, leaves] of Object.entries(hooksMap)) {
    if (leaves.some(isRegimenLeaf)) removed.push({ event, role: "capture" });
    const kept = leaves.filter((l) => !isRegimenLeaf(l));
    if (kept.length > 0) hooksMap[event] = kept;
    else delete hooksMap[event];
  }
  return { hooks: base as HooksFile, removed };
}

/**
 * Merge Feedback's capture hook into a fresh-or-existing file, selecting the
 * on-disk structure from the descriptor's contract format. The leaf identity,
 * marker, and command are shared across formats; only the structure around the
 * leaves differs (`nested-matcher-groups` wraps each leaf in a matcher-group;
 * `versioned-command-leaves` lists flat leaves under a top-level `version`).
 */
export function planCaptureHooks(
  existing: HooksFile | VersionedHooksFile | undefined,
  ctx: WireContext,
): WirePlan {
  if (!isAbsolute(ctx.clonePath)) {
    throw new Error(`clonePath must be absolute, got: ${ctx.clonePath}`);
  }
  if (ctx.descriptor.contract.hooksFile.format === "versioned-command-leaves") {
    return planVersionedCaptureHooks(
      existing as VersionedHooksFile | undefined,
      ctx,
    );
  }
  const nested = existing as HooksFile | undefined;
  assertWellFormed(nested);
  const base: HooksFile = nested ? structuredClone(nested) : {};
  const hooksMap = base.hooks ?? {};
  base.hooks = hooksMap;
  const added: WireChange[] = [];
  const unchanged: WireChange[] = [];

  for (const event of ctx.descriptor.capture.events) {
    const groups = hooksMap[event] ?? [];
    const hadCapture = groups.flatMap((g) => g.hooks).some(isRegimenLeaf);

    const userGroups = stripRegimen(groups);
    hooksMap[event] = [...userGroups, { hooks: [captureLeaf(ctx)] }];

    (hadCapture ? unchanged : added).push({ event, role: "capture" });
  }
  return { hooks: base, added, unchanged };
}

/**
 * Remove exactly Feedback's capture entries; leave the user's and any foreign
 * gate leaves intact. The `format` selects the on-disk structure to strip,
 * defaulting to `nested-matcher-groups` so the three nested harnesses' callers
 * are unchanged; Copilot's `versioned-command-leaves` is passed explicitly.
 */
export function planCaptureHooksRemoval(
  existing: HooksFile | VersionedHooksFile | undefined,
  format: HooksFormat = "nested-matcher-groups",
): UnwirePlan {
  if (format === "versioned-command-leaves") {
    return planVersionedCaptureHooksRemoval(
      existing as VersionedHooksFile | undefined,
    );
  }
  const nested = existing as HooksFile | undefined;
  assertWellFormed(nested);
  const base: HooksFile = nested ? structuredClone(nested) : {};
  const removed: WireChange[] = [];
  const hooksMap = base.hooks;
  if (hooksMap === undefined) return { hooks: base, removed };

  for (const [event, groups] of Object.entries(hooksMap)) {
    for (const leaf of groups.flatMap((g) => g.hooks)) {
      if (!isRegimenLeaf(leaf)) continue;
      removed.push({ event, role: "capture" });
    }
    const kept = stripRegimen(groups);
    if (kept.length > 0) hooksMap[event] = kept;
    else delete hooksMap[event];
  }
  return { hooks: base, removed };
}
