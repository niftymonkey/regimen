/**
 * The harness CONTRACT: the data subset about an agent CLI that is shared
 * across the Regimen instruments (Feedback and Enforcement). It is pure data:
 * where a harness keeps its config home, where its hooks file lives and in what
 * format, and where its skills install.
 *
 * The canonical spec is the CLI's docs/harness-descriptor-contract.md (to be
 * published). Now that the instruments share one workspace, this contract lives
 * in `@regimen/shared` and both instruments import it rather than each holding a
 * hand-copied byte-identical version.
 *
 * Only the `Harness` type is imported (the shared identifier set); the contract
 * data itself is self-contained.
 */
import type { Harness } from "../harness.ts";

/**
 * Where a harness keeps its configuration home: the environment variable that
 * overrides it (e.g. CODEX_HOME) and the subdirectory of the user's home used
 * as the default (e.g. ".codex" for ~/.codex).
 */
export interface ConfigHome {
  readonly envVar: string;
  readonly defaultSubdir: string;
}

/**
 * Where a harness keeps its hooks configuration, relative to the config home,
 * and the on-disk shape. `nested-matcher-groups` is Codex's hooks.json format
 * (events to matcher-groups to command leaves).
 */
export interface HooksFile {
  readonly relativePath: string;
  readonly format: "nested-matcher-groups";
}

/**
 * The shared, cross-instrument contract for one harness. Pure data. The skills
 * subdirectory is relative to the config home (target
 * `<configHome>/<skillsSubdir>/<name>/SKILL.md`).
 */
export interface HarnessContract {
  readonly harness: Harness;
  readonly configHome: ConfigHome;
  readonly hooksFile: HooksFile;
  readonly skillsSubdir: string;
}

const CODEX_CONTRACT: HarnessContract = {
  harness: "codex",
  configHome: { envVar: "CODEX_HOME", defaultSubdir: ".codex" },
  hooksFile: { relativePath: "hooks.json", format: "nested-matcher-groups" },
  skillsSubdir: "skills",
};

/**
 * Claude Code's config home is `CLAUDE_CONFIG_DIR` (default `~/.claude`); its
 * hooks live in `settings.json` under the same event-to-matcher-groups shape
 * as Codex's `hooks.json`; skills install to `<configHome>/skills/<name>`.
 * Values verified against the official Claude Code env-vars and hooks docs.
 */
const CLAUDE_CONTRACT: HarnessContract = {
  harness: "claude",
  configHome: { envVar: "CLAUDE_CONFIG_DIR", defaultSubdir: ".claude" },
  hooksFile: {
    relativePath: "settings.json",
    format: "nested-matcher-groups",
  },
  skillsSubdir: "skills",
};

/**
 * GitHub Copilot CLI's config home is `COPILOT_HOME` (default `~/.copilot`);
 * skills install to `<configHome>/skills/<name>`. Values verified against the
 * installed `@github/copilot` package and the official Copilot hooks docs.
 *
 * DIVERGENCE NOTE: Copilot's on-disk hooks file (`~/.copilot/hooks/*.json`, or
 * a plugin's `hooks/hooks.json`) is NOT the `nested-matcher-groups` shape Codex
 * and Claude use (event -> matcher-groups -> command leaves). Copilot wraps the
 * config in a `{ version: 1, hooks: { <event>: [ leaf, ... ] } }` envelope where
 * each leaf is a FLAT command object (`{ type: "command", bash, powershell,
 * command, exec, matcher? }`) with an optional inline `matcher`, not a nested
 * matcher group. The `HooksFile.format` union cannot express that today, and
 * widening it touches the enforcement gate planner, so this row records the
 * closest reasonable `relativePath` with the existing format value only to
 * satisfy the type. The hooksFile is not load-bearing for the Feedback judge
 * path (which reads transcripts, not hooks); Copilot live-capture install
 * wiring is deferred with the translator.
 */
const COPILOT_CONTRACT: HarnessContract = {
  harness: "copilot",
  configHome: { envVar: "COPILOT_HOME", defaultSubdir: ".copilot" },
  hooksFile: {
    relativePath: "hooks/hooks.json",
    format: "nested-matcher-groups",
  },
  skillsSubdir: "skills",
};

/** The cross-instrument harness contracts, keyed by normalized identifier. */
export const HARNESS_CONTRACTS: ReadonlyMap<Harness, HarnessContract> = new Map(
  [
    ["codex", CODEX_CONTRACT],
    ["claude", CLAUDE_CONTRACT],
    ["copilot", COPILOT_CONTRACT],
  ],
);

/** The contract for `harness`, or undefined when no contract is registered. */
export function harnessContract(harness: Harness): HarnessContract | undefined {
  return HARNESS_CONTRACTS.get(harness);
}
