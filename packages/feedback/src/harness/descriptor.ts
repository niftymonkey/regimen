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
 * The per-group decoration some `nested-matcher-groups` harnesses require on
 * every capture hook group for the hook to fire. Gemini is the one harness that
 * needs it (ADR-0011, docs/harness-divergences.md): a Session-1 controlled
 * differential proved its headless run fires a group only when that group carries
 * both a `name` and a `matcher`. The `name` is per-event (`<namePrefix><event>`,
 * event lowercased); the `matcher` is static. Absent on harnesses whose bare
 * groups already fire (Codex, Claude).
 */
export interface GroupDecoration {
  readonly namePrefix: string;
  readonly matcher: string;
}

/**
 * The feedback-private capture facts for one harness: the harness events the
 * capture hook subscribes to, the producer script (relative to the repo root)
 * whose `bun <clonePath>/<producerScript>` command the hooks file invokes, the
 * leaf marker that identifies Feedback's own leaves, and the optional per-group
 * decoration a harness requires for its hook groups to fire.
 */
export interface CaptureDescriptor {
  readonly events: readonly string[];
  readonly producerScript: string;
  readonly leafMarker: CaptureLeafMarker;
  readonly groupDecoration?: GroupDecoration;
  /**
   * A one-line notice the installer prints after a successful capture wire, for a
   * harness whose freshly-installed hooks do not fire until the user trusts them
   * once. Absent on harnesses that fire fresh hooks immediately (Claude, Copilot,
   * Gemini); present only on Codex, where interactive runs silently skip untrusted
   * hooks and headless `codex exec` needs `--dangerously-bypass-hook-trust`, so
   * first-run capture is silently empty without the notice.
   */
  readonly firstUseNotice?: string;
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
  firstUseNotice:
    "Codex will not fire these hooks until you trust them once: approve the Regimen hook on first interactive run, or headless `codex exec` needs --dangerously-bypass-hook-trust.",
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

/**
 * Gemini CLI's hook event names are PascalCase (verified against the installed
 * `@google/gemini-cli` package's `docs/hooks/reference.md`): the full lifecycle
 * is `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`,
 * `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`,
 * `Notification`, `Stop`. The capture subset below mirrors how the Codex and
 * Claude descriptors pick theirs: the session boundary (`SessionStart` /
 * `SessionEnd`), the user-prompt-equivalent (`BeforeAgent`, which fires after a
 * user submits a prompt and before the agent plans), the tool round-trip
 * (`BeforeTool` / `AfterTool`), and the compaction boundary (`PreCompress`). The
 * live-capture hook translator is deferred until the full Gemini hook payload
 * taxonomy is producer-confirmed (only the reader path is wired today), so these
 * events drive only the install plan, not a registered translator.
 */
const GEMINI_CAPTURE: CaptureDescriptor = {
  events: [
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "BeforeTool",
    "AfterTool",
    "PreCompress",
  ],
  producerScript: "hooks/capture-gemini.ts",
  leafMarker: { v: 1, role: "capture" },
  groupDecoration: { namePrefix: "regimen-capture-", matcher: "*" },
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
    ["gemini", descriptorFor("gemini", GEMINI_CAPTURE, "tmp")],
  ]);

/** The descriptor for `harness`, or undefined when none is registered. */
export function harnessDescriptor(
  harness: Harness,
): HarnessDescriptor | undefined {
  return HARNESS_DESCRIPTORS.get(harness);
}
