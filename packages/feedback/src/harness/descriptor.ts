/**
 * The harness DESCRIPTOR: the feedback-private superset of the shared contract.
 *
 * The contract (contract.ts) holds the data both Regimen packages share. The
 * descriptor adds the capture facts that belong to the feedback package alone: the
 * harness events the capture hook subscribes to, the producer script that emits
 * the envelope, and the sentinel leaf marker that identifies Feedback's own
 * hook leaves. Keeping these as DATA on the descriptor (not as a CaptureStrategy
 * port) is deliberate: capture is one shape, parameterized per harness, not a
 * pluggable behavior.
 *
 * Pure data only. Nothing here reads the filesystem or runs a hook.
 */
import type { Harness } from "@regimen/shared";
import { harnessContract, type HarnessContract } from "@regimen/shared";

/**
 * The sentinel marker stamped on each Feedback-owned hook leaf, the
 * path-independent identity used to dedup on re-install and to remove exactly
 * Feedback's leaves on uninstall. Feedback writes `role:"capture"`;
 * `role:"gate"` belongs to the enforcement package.
 */
export interface CaptureLeafMarker {
  readonly v: 1;
  readonly role: "capture";
}

/**
 * The feedback-private capture facts for one harness: the harness events the
 * capture hook subscribes to, the producer script (relative to the repo root)
 * whose `bun <clonePath>/<producerScript>` command the hooks file invokes, and
 * the leaf marker that identifies Feedback's own leaves.
 */
export interface CaptureDescriptor {
  readonly events: readonly string[];
  readonly producerScript: string;
  readonly leafMarker: CaptureLeafMarker;
}

/** The full feedback-private descriptor for one harness: contract plus capture. */
export interface HarnessDescriptor {
  readonly contract: HarnessContract;
  readonly capture: CaptureDescriptor;
}

const CODEX_CAPTURE: CaptureDescriptor = {
  events: [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
  ],
  producerScript: "hooks/capture-codex.ts",
  leafMarker: { v: 1, role: "capture" },
};

function descriptorFor(
  harness: Harness,
  capture: CaptureDescriptor,
): HarnessDescriptor {
  const contract = harnessContract(harness);
  if (contract === undefined) {
    throw new Error(`no harness contract registered for harness ${harness}`);
  }
  return { contract, capture };
}

/** The feedback-private descriptors, keyed by normalized harness identifier. */
export const HARNESS_DESCRIPTORS: ReadonlyMap<Harness, HarnessDescriptor> =
  new Map([["codex", descriptorFor("codex", CODEX_CAPTURE)]]);

/**
 * The CLI-set environment marker each harness stamps into the agent's shell,
 * the one sanctioned place a harness name is bound to a concrete env var. The
 * resolver reads this map to detect which harness the CLI is running inside; a
 * harness whose marker env var is present and non-empty is that harness.
 *
 * These are the markers the harness CLI sets, NOT generic provider keys: a model
 * provider's API key (e.g. an Anthropic key in the shell) does not imply the
 * Claude Code CLI is the running harness. The map is independent of
 * HARNESS_DESCRIPTORS: it covers all four CLIs even though only codex has a full
 * descriptor today, so detection can name a harness that has no support entry,
 * and the downstream registry lookup then fails closed.
 */
export const HARNESS_ENV_MARKERS: ReadonlyMap<Harness, string> = new Map([
  ["claude", "CLAUDECODE"],
  ["codex", "CODEX_THREAD_ID"],
  ["gemini", "GEMINI_CLI"],
  ["copilot", "COPILOT_CLI"],
]);

/** The descriptor for `harness`, or undefined when none is registered. */
export function harnessDescriptor(
  harness: Harness,
): HarnessDescriptor | undefined {
  return HARNESS_DESCRIPTORS.get(harness);
}
