/**
 * The harness CONTRACT: the data subset about an agent CLI that is shared,
 * byte-identical, across the Regimen repos (regimen-feedback and
 * regimen-enforcement). It is pure data: where a harness keeps its config home,
 * where its hooks file lives and in what format, and where its skills install.
 *
 * IMPORTANT: this module is kept BYTE-IDENTICAL across regimen-feedback and
 * regimen-enforcement. Do not add anything repo-private here (capture facts,
 * imports of feedback-only modules, behavior). The canonical spec is the hub's
 * docs/harness-descriptor-contract.md (to be published). When the repos are
 * later consolidated, this is the one file that merges with zero diff.
 *
 * Only the `Harness` type is imported (the shared identifier set); the contract
 * data itself is self-contained so the byte-identical copy has no repo-private
 * dependency beyond that one shared type.
 */
import type { Harness } from "../../hooks/event-log.ts";

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
 * The shared, cross-repo contract for one harness. Pure data. The skills
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

/** The cross-repo harness contracts, keyed by normalized harness identifier. */
export const HARNESS_CONTRACTS: ReadonlyMap<Harness, HarnessContract> = new Map(
  [["codex", CODEX_CONTRACT]],
);

/** The contract for `harness`, or undefined when no contract is registered. */
export function harnessContract(harness: Harness): HarnessContract | undefined {
  return HARNESS_CONTRACTS.get(harness);
}
