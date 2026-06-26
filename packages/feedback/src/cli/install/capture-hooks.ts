/**
 * Feedback's capture-side wiring: a THIN wrapper over the shared, role-
 * parameterized hooks engine (`@regimen/shared`). It supplies the capture ROLE
 * (its identity marker, the events to wire, the one capture leaf per event, and
 * Gemini's per-group decoration) and delegates the merge, idempotency, marker
 * stamping, format branch, and pruning to the engine. The engine is the same one
 * Enforcement's gate install wires through, so the two instruments share one
 * proven merge.
 *
 * It wires Feedback's capture hook onto the harness events idempotently and
 * without clobbering the user's own hooks. The events to subscribe, the producer
 * script the command invokes, and the sentinel leaf marker all come from the
 * harness descriptor (data, not hardcoded), so a new harness flows through
 * without editing this wrapper. Feedback recognizes its own entries by the
 * descriptor's marker (`_regimen`) stamped on each leaf hook, not by the command
 * string, so recognition survives a moved clone.
 *
 * Feedback owns only `role:"capture"` leaves; the enforcement package owns
 * `role:"gate"` leaves in the same hooks file, so the capture role's recognizer
 * is scoped to capture: a foreign gate leaf (and the user's own hooks) is
 * preserved verbatim, touching only capture leaves.
 */
import { isAbsolute, join } from "node:path";
import {
  type GroupDecoration,
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
import type { HarnessDescriptor } from "../../harness/descriptor.ts";

export type {
  LeafHook,
  MatcherGroup,
  RegimenMarker,
  VersionedHooksFile,
} from "@regimen/shared";
/** A parsed hooks.json. Re-exported under Feedback's historical name. */
export type HooksFile = ParsedHooksFile;

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

export type WirePlan = EngineWirePlan<WireChange>;
export type UnwirePlan = EngineUnwirePlan<WireChange>;

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
 * The capture hook command, rooted at the clone, from the descriptor's producer
 * script. The joined path is forward-slashed so the command survives a
 * POSIX-style shell on native Windows (which strips backslashes); bun resolves a
 * forward-slash Windows path, and on Linux/macOS the replace is a no-op.
 */
export function captureCommand(
  clonePath: string,
  producerScript: string,
): string {
  return `bun ${join(clonePath, producerScript).replaceAll("\\", "/")}`;
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
 * The capture decoration for one event, present only on a harness whose
 * descriptor carries `groupDecoration` (Gemini, per ADR-0011): the group must
 * carry a `name` (`<namePrefix><event>`, event lowercased) and a static `matcher`
 * for the hook to fire headless. Absent on harnesses whose bare groups fire.
 */
function captureDecoration(
  event: string,
  ctx: WireContext,
): GroupDecoration | undefined {
  const decoration = ctx.descriptor.capture.groupDecoration;
  if (decoration === undefined) return undefined;
  return {
    name: `${decoration.namePrefix}${event.toLowerCase()}`,
    matcher: decoration.matcher,
  };
}

/** The capture role the shared engine wires: capture identity, one leaf per event, Gemini decoration. */
function captureRole(ctx: WireContext): WireRole<WireChange> {
  return {
    isOwnLeaf: isRegimenLeaf,
    events: ctx.descriptor.capture.events,
    buildLeaves(event, existingOwn) {
      const change: WireChange = { event, role: "capture" };
      return existingOwn.length > 0
        ? { leaves: [captureLeaf(ctx)], added: [], unchanged: [change] }
        : { leaves: [captureLeaf(ctx)], added: [change], unchanged: [] };
    },
    decorationFor: (event) => captureDecoration(event, ctx),
    removalChangeFor: (event) => ({ event, role: "capture" }),
  };
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
  return planHooks(
    existing,
    captureRole(ctx),
    ctx.descriptor.contract.hooksFile.format,
  );
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
  return planHooksRemoval(existing, removalRole(), format);
}

/** The capture role for removal: only the identity and the per-leaf change matter. */
function removalRole(): WireRole<WireChange> {
  return {
    isOwnLeaf: isRegimenLeaf,
    events: [],
    buildLeaves: (event) => ({
      leaves: [],
      added: [],
      unchanged: [{ event, role: "capture" }],
    }),
    decorationFor: () => undefined,
    removalChangeFor: (event) => ({ event, role: "capture" }),
  };
}
