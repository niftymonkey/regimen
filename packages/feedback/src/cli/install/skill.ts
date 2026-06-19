/**
 * The install-skill planner: where each bundled SKILL.md comes from and where it
 * lands under the harness config home's skills subdirectory.
 *
 * Pure: resolves the paths for every bundled skill from a context the CLI
 * assembles, so the CLI can dry-run (print the targets) or copy without this
 * module touching the filesystem. The harness discovers skills as
 * `<home>/<contract.skillsSubdir>/<name>/SKILL.md`; the subdirectory comes from
 * the contract (data, not hardcoded). The bundle ships more than one skill;
 * adding another is one entry in `BUNDLED_SKILLS`, not a new code path.
 */
import { join } from "node:path";
import type { HarnessContract } from "../../harness/contract.ts";

/**
 * The skills this repo bundles, by their `<home>/<skillsSubdir>/<name>/`
 * directory. `feedback-evidence` is the deterministic evidence check;
 * `feedback-judgment` is its judged twin. Order is the install order.
 */
export const BUNDLED_SKILLS = [
  "feedback-evidence",
  "feedback-judgment",
] as const;

export interface SkillInstallContext {
  /** The harness config home whose skills subdirectory receives the skills. */
  readonly home: string;
  /** The repo root that holds the bundled `skills/` directory. */
  readonly bundleDir: string;
  /** The harness contract: its `skillsSubdir` is where skills install. */
  readonly contract: HarnessContract;
}

export interface SkillInstallPlan {
  /** The bundled skill's directory name under the skills subdirectory. */
  readonly name: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

/** Resolve the source and harness-home target for every bundled skill. */
export function planSkillInstall(
  ctx: SkillInstallContext,
): ReadonlyArray<SkillInstallPlan> {
  return BUNDLED_SKILLS.map((name) => ({
    name,
    sourcePath: join(ctx.bundleDir, "skills", name, "SKILL.md"),
    targetPath: join(ctx.home, ctx.contract.skillsSubdir, name, "SKILL.md"),
  }));
}
