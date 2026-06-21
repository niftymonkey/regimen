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

/**
 * The full feedback-private descriptor for one harness: the shared contract, the
 * capture facts, and where the harness keeps its session transcripts relative to
 * its config home. `transcriptsSubdir` is feedback-private because only Feedback
 * reads transcripts (Codex keeps them in `sessions`; Claude in `projects`), so
 * the judge path joins `<configHome>/<transcriptsSubdir>` without naming a
 * harness in the generic code.
 */
export interface HarnessDescriptor {
  readonly contract: HarnessContract;
  readonly capture: CaptureDescriptor;
  readonly transcriptsSubdir: string;
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

const CLAUDE_CAPTURE: CaptureDescriptor = {
  events: [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
  ],
  producerScript: "hooks/capture.ts",
  leafMarker: { v: 1, role: "capture" },
};

/**
 * Copilot CLI's hook event names are camelCase (verified against the installed
 * `@github/copilot` package and the official Copilot hooks docs):
 * `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`,
 * `postToolUse`, `preCompact`. Only `postToolUse` has been observed firing in a
 * real session log on this box; the rest are confirmed from the package's hook
 * type list. The live-capture hook translator is deferred until the full hook
 * payload taxonomy is producer-confirmed (only the reader path is wired today),
 * so these events drive only the install plan, not a registered translator.
 */
const COPILOT_CAPTURE: CaptureDescriptor = {
  events: [
    "sessionStart",
    "sessionEnd",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "preCompact",
  ],
  producerScript: "hooks/capture-copilot.ts",
  leafMarker: { v: 1, role: "capture" },
};

function descriptorFor(
  harness: Harness,
  capture: CaptureDescriptor,
  transcriptsSubdir: string,
): HarnessDescriptor {
  const contract = harnessContract(harness);
  if (contract === undefined) {
    throw new Error(`no harness contract registered for harness ${harness}`);
  }
  return { contract, capture, transcriptsSubdir };
}

/** The feedback-private descriptors, keyed by normalized harness identifier. */
export const HARNESS_DESCRIPTORS: ReadonlyMap<Harness, HarnessDescriptor> =
  new Map([
    ["codex", descriptorFor("codex", CODEX_CAPTURE, "sessions")],
    ["claude", descriptorFor("claude", CLAUDE_CAPTURE, "projects")],
    ["copilot", descriptorFor("copilot", COPILOT_CAPTURE, "session-state")],
  ]);

/** The descriptor for `harness`, or undefined when none is registered. */
export function harnessDescriptor(
  harness: Harness,
): HarnessDescriptor | undefined {
  return HARNESS_DESCRIPTORS.get(harness);
}
