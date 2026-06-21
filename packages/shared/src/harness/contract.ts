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
 * and the on-disk shape. Two structural formats exist across the harnesses:
 *   - `nested-matcher-groups`: Codex's hooks.json / Claude's settings.json shape
 *     (events to matcher-groups, each group holding a command-leaf array).
 *   - `versioned-command-leaves`: Copilot's shape, a `{ version, hooks: { <event>:
 *     [ leaf, ... ] } }` envelope where each leaf is a flat command object with an
 *     optional inline matcher (no nested matcher group).
 * The value is descriptive metadata: no code switches on it today (the install
 * planners read `relativePath` and structurally assume their own shape). It names
 * the harness's real on-disk format so the install planner that writes each can
 * be selected by it when that work lands.
 */
/**
 * The on-disk structural format of a harness's hooks file. Named so an install
 * planner can branch on it (and be typed by it) rather than restating the union.
 */
export type HooksFormat = "nested-matcher-groups" | "versioned-command-leaves";

export interface HooksFile {
  readonly relativePath: string;
  readonly format: HooksFormat;
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
 * Copilot's on-disk hooks file (`~/.copilot/hooks/*.json`, or a plugin's
 * `hooks/hooks.json`) uses the `versioned-command-leaves` format, NOT the
 * `nested-matcher-groups` shape Codex and Claude use: a `{ version: 1, hooks: {
 * <event>: [ leaf, ... ] } }` envelope where each leaf is a flat command object
 * (`{ type: "command", bash, powershell, command, exec, matcher? }`) with an
 * optional inline `matcher`. This row names that format accurately so the planner
 * that writes Copilot's shape can be selected by it when that work lands. NOTE:
 * no install planner writes the `versioned-command-leaves` shape yet (the
 * capture/gate planners hardcode `nested-matcher-groups` and run only for Codex
 * and Claude today), so Copilot hooks WRITING is unimplemented; this is not
 * load-bearing for the Feedback judge path (which reads transcripts, not hooks).
 */
const COPILOT_CONTRACT: HarnessContract = {
  harness: "copilot",
  configHome: { envVar: "COPILOT_HOME", defaultSubdir: ".copilot" },
  hooksFile: {
    relativePath: "hooks/hooks.json",
    format: "versioned-command-leaves",
  },
  skillsSubdir: "skills",
};

/**
 * Gemini CLI's config home is `GEMINI_CONFIG_DIR` (default `~/.gemini`); its
 * hooks live in `settings.json` under the same event-to-matcher-groups shape as
 * Codex's `hooks.json` and Claude's `settings.json` (event -> hook definitions,
 * each with an optional `matcher` and a `hooks` array of command leaves), so
 * Gemini uses `nested-matcher-groups` with no divergence (unlike Copilot).
 * Skills install to `<configHome>/skills/<name>`. Values verified against the
 * installed `@google/gemini-cli` package's hooks reference and config docs.
 */
const GEMINI_CONTRACT: HarnessContract = {
  harness: "gemini",
  configHome: { envVar: "GEMINI_CONFIG_DIR", defaultSubdir: ".gemini" },
  hooksFile: {
    relativePath: "settings.json",
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
    ["gemini", GEMINI_CONTRACT],
  ],
);

/** The contract for `harness`, or undefined when no contract is registered. */
export function harnessContract(harness: Harness): HarnessContract | undefined {
  return HARNESS_CONTRACTS.get(harness);
}
