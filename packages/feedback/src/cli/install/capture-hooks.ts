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

/** Merge Feedback's capture hook into a fresh-or-existing file. */
export function planCaptureHooks(
  existing: HooksFile | undefined,
  ctx: WireContext,
): WirePlan {
  if (!isAbsolute(ctx.clonePath)) {
    throw new Error(`clonePath must be absolute, got: ${ctx.clonePath}`);
  }
  assertWellFormed(existing);
  const base: HooksFile = existing ? structuredClone(existing) : {};
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

/** Remove exactly Feedback's capture entries; leave the user's and any foreign gate leaves intact. */
export function planCaptureHooksRemoval(
  existing: HooksFile | undefined,
): UnwirePlan {
  assertWellFormed(existing);
  const base: HooksFile = existing ? structuredClone(existing) : {};
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
