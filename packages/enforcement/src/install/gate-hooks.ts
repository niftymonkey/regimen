/**
 * Enforcement's gate-side wiring: a THIN wrapper over the shared, role-
 * parameterized hooks engine (`@regimen/shared`). It supplies the gate ROLE (its
 * identity marker, the harness's pre-tool event, the deduped gate leaves, and
 * Gemini's name+matcher group decoration) and delegates the merge, idempotency,
 * marker stamping, format branch, and pruning to the engine. The engine is the
 * same one Feedback's capture install wires through, so the two instruments share
 * one proven merge.
 *
 * This is a LIBRARY function, not an install step: with no shipped gate catalog,
 * `enforcement install` lays down only the operator skill (see the facade). The
 * `enforcement-respond` skill calls this planner at AUTHORING time, when the
 * engineer confirms an authored gate, to merge that gate onto the right
 * per-harness pre-tool event. The gate is the engineer's own (`id` plus the body
 * `scriptPath`); the wiring, idempotency, and marker stamping are Regimen's
 * reusable seam.
 *
 * Enforcement owns discipline gates, not the capture hook, so the gate role's
 * recognizer touches only `role:"gate"` leaves: it preserves a `role:"capture"`
 * leaf (wired by Feedback's own installer) and the user's own hooks verbatim.
 * Regimen recognizes its own gate entries by a sentinel marker (`_regimen`)
 * stamped on each leaf, not by the command string, so recognition survives a
 * moved clone.
 */
import { basename, isAbsolute } from "node:path";
import {
  assertSafeClonePath,
  type Harness,
  harnessContract,
  type HooksFormat,
  type LeafHook,
  type ParsedHooksFile,
  planHooks,
  planHooksRemoval,
  type UnwirePlan as EngineUnwirePlan,
  type VersionedHooksFile,
  type WirePlan as EngineWirePlan,
  type WireRole,
} from "@regimen/shared";
import { buildGateCommand, type GateId } from "./gate-command.ts";

export type { GateId } from "./gate-command.ts";
export { buildGateCommand } from "./gate-command.ts";
export { assertSafeClonePath } from "@regimen/shared";

export type {
  LeafHook,
  MatcherGroup,
  VersionedHooksFile,
} from "@regimen/shared";
/** A parsed hooks.json. Re-exported under Enforcement's historical name. */
export type HooksFile = ParsedHooksFile;

/** The sentinel marker stamped on each Enforcement-owned gate leaf. */
export interface RegimenMarker {
  readonly v: 1;
  readonly role: "capture" | "gate";
  readonly id?: GateId;
}

/**
 * An authored gate: the engineer's own gate body, named and located. `id` is the
 * name the engineer gives it (the marker the wiring stamps and dedups on);
 * `scriptPath` is the gate body's path under the clone, the `bun` body the
 * respond-helper authored Windows-safe in TypeScript. Enforcement ships no fixed
 * catalog of these; the helper supplies them on demand.
 */
export interface AuthoredGate {
  readonly id: GateId;
  readonly scriptPath: string;
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
  /** The harness the gates are wired for; carried as REGIMEN_HARNESS. */
  readonly harness: Harness;
  /** The authored gates to wire onto the pre-tool boundary. */
  readonly gates: ReadonlyArray<AuthoredGate>;
}

/** One gate-entry change, for the caller to report. */
export interface GateChange {
  readonly event: string;
  readonly id: GateId;
}

export type WirePlan = EngineWirePlan<GateChange>;
export type UnwirePlan = EngineUnwirePlan<GateChange>;

/** True iff a leaf hook is a gate Enforcement owns (marker role "gate"). */
export function isGateLeaf(leaf: LeafHook): boolean {
  return leaf._regimen?.role === "gate";
}

/**
 * The script path a gate command points at, for dedup by basename. The command
 * string quotes the interpolated path (so a space in the clone path stays one
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

/** A fresh gate leaf for the given authored gate, clone, and harness. */
function gateLeaf(
  gate: AuthoredGate,
  clonePath: string,
  harness: Harness,
): LeafHook {
  return {
    type: "command",
    command: buildGateCommand(clonePath, gate.scriptPath, harness),
    _regimen: { v: 1, role: "gate", id: gate.id },
  };
}

/**
 * The deduped gate leaves to wire and the added/unchanged report, given the
 * role's own gate leaves already present on the event. The already-wired gates
 * are re-emitted first, in their on-disk order, so a plain re-run is a no-op and
 * nothing reorders; a gate the caller re-supplies by id re-homes onto the
 * caller's current clone and scriptPath (a moved clone or a re-authored body),
 * while one the caller does not re-supply is preserved verbatim. The caller's new
 * gates are appended last. Deduped by gate id (an id already wired is not
 * re-added) and by script basename (two ids resolving to the same script file
 * would double-wire one gate). Format-independent: the engine wraps the same
 * leaves differently by the nested and versioned writers.
 */
function buildGateLeaves(
  existingOwn: ReadonlyArray<LeafHook>,
  ctx: GateContext,
  event: string,
): { leaves: LeafHook[]; added: GateChange[]; unchanged: GateChange[] } {
  const added: GateChange[] = [];
  const unchanged: GateChange[] = [];
  const seenBasenames = new Set<string>();
  const leaves: LeafHook[] = [];
  const requestedById = new Map(ctx.gates.map((g) => [g.id, g]));
  const existingIds = new Set(
    existingOwn
      .map((l) => l._regimen?.id)
      .filter((id): id is GateId => id !== undefined),
  );

  for (const existing of existingOwn) {
    const id = existing._regimen?.id;
    if (id === undefined) continue;
    // A re-supplied gate re-homes (its command is rebuilt from the current clone);
    // one not re-supplied is preserved exactly as it is on disk.
    const reSupplied = requestedById.get(id);
    const leaf =
      reSupplied === undefined
        ? existing
        : gateLeaf(reSupplied, ctx.clonePath, ctx.harness);
    const name = commandBasename(leaf.command);
    if (seenBasenames.has(name)) continue;
    seenBasenames.add(name);
    leaves.push(leaf);
    unchanged.push({ event, id });
  }

  for (const gate of ctx.gates) {
    if (existingIds.has(gate.id)) continue;
    const leaf = gateLeaf(gate, ctx.clonePath, ctx.harness);
    const name = commandBasename(leaf.command);
    if (seenBasenames.has(name)) continue;
    seenBasenames.add(name);
    leaves.push(leaf);
    added.push({ event, id: gate.id });
  }

  return { leaves, added, unchanged };
}

/** The gate role the shared engine wires: gate identity, one event, deduped leaves, Gemini decoration. */
function gateRole(
  ctx: GateContext,
  profile: GateProfile,
): WireRole<GateChange> {
  return {
    isOwnLeaf: isGateLeaf,
    events: [profile.preToolEvent],
    buildLeaves(event, existingOwn) {
      return buildGateLeaves(existingOwn, ctx, event);
    },
    decorationFor: (event) =>
      profile.needsNameMatcher
        ? { name: `regimen-gate-${event}`, matcher: "*" }
        : undefined,
    removalChangeFor: (event, leaf) => {
      const id = leaf._regimen?.id as GateId | undefined;
      return id === undefined ? undefined : { event, id };
    },
  };
}

/**
 * Merge the authored gates into a fresh-or-existing file on the harness's
 * pre-tool event, selecting the on-disk shape from the harness's gate profile and
 * the shared contract's hooks format. Surgical and additive: it touches only gate
 * leaves, appends its gates AFTER any existing capture leaf or user hook, dedups
 * by gate id and by script basename, and a plain re-run never drops a gate wired
 * earlier. Throws on a relative clonePath, a shell-unsafe clonePath, a malformed
 * existing file, or an unregistered harness.
 */
export function planGateHooks(
  existing: HooksFile | VersionedHooksFile | undefined,
  ctx: GateContext,
): WirePlan {
  if (!isAbsolute(ctx.clonePath)) {
    throw new Error(`clonePath must be absolute, got: ${ctx.clonePath}`);
  }
  assertSafeClonePath(ctx.clonePath);
  const contract = harnessContract(ctx.harness);
  if (contract === undefined) {
    throw new Error(`no contract registered for harness: ${ctx.harness}`);
  }
  const profile = GATE_PROFILES[ctx.harness];
  if (profile === undefined) {
    throw new Error(`no gate profile registered for harness: ${ctx.harness}`);
  }
  return planHooks(existing, gateRole(ctx, profile), contract.hooksFile.format);
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
  return planHooksRemoval(existing, removalRole(), format);
}

/** The gate role for removal: only the identity and the per-leaf change matter. */
function removalRole(): WireRole<GateChange> {
  return {
    isOwnLeaf: isGateLeaf,
    events: [],
    buildLeaves: () => ({ leaves: [], added: [], unchanged: [] }),
    decorationFor: () => undefined,
    removalChangeFor: (event, leaf) => {
      const id = leaf._regimen?.id as GateId | undefined;
      return id === undefined ? undefined : { event, id };
    },
  };
}
