/**
 * The install-skill planner: where each bundled SKILL.md comes from and where it
 * lands under the harness config home's skills subdirectory. Shared by every
 * lever's install layer (the machinery is harness-agnostic; the bundled skill
 * list is data each package supplies).
 *
 * Pure: resolves the paths for a caller-supplied skill list from a context the
 * CLI assembles, so the CLI can dry-run (print the targets) or copy without this
 * module touching the filesystem. The harness discovers skills as
 * `<home>/<contract.skillsSubdir>/<name>/SKILL.md`; the subdirectory comes from
 * the contract (data, not hardcoded). Each package passes its OWN skills (from
 * its OWN `bundleDir`): Feedback bundles `BUNDLED_SKILLS`, Enforcement bundles
 * its respond-helper. Adding another skill is one entry in a package's list, not
 * a new code path.
 */
import { join } from "node:path";
import type { HarnessContract } from "../harness/contract.ts";

/**
 * The skills the Feedback package bundles, by their
 * `<home>/<skillsSubdir>/<name>/` directory. `regimen-evidence` is the
 * deterministic evidence check; `regimen-judgment` is its judged twin. Order is
 * the install order. Each lever package owns its own list and passes it as the
 * context's `skills`; this constant is Feedback's.
 */
export const BUNDLED_SKILLS = ["regimen-evidence", "regimen-judgment"] as const;

export interface SkillInstallContext {
  /** The harness config home whose skills subdirectory receives the skills. */
  readonly home: string;
  /** The repo root that holds the bundled `skills/` directory. */
  readonly bundleDir: string;
  /** The harness contract: its `skillsSubdir` is where skills install. */
  readonly contract: HarnessContract;
  /**
   * The skill directory names to plan, in install order. Defaults to Feedback's
   * `BUNDLED_SKILLS`; each lever package passes its own (Enforcement passes its
   * respond-helper) so it bundles only its own skills from its own `bundleDir`.
   */
  readonly skills?: ReadonlyArray<string>;
}

export interface SkillInstallPlan {
  /** The bundled skill's directory name under the skills subdirectory. */
  readonly name: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

/** Resolve the source and harness-home target for each requested skill. */
export function planSkillInstall(
  ctx: SkillInstallContext,
): ReadonlyArray<SkillInstallPlan> {
  return (ctx.skills ?? BUNDLED_SKILLS).map((name) => ({
    name,
    sourcePath: join(ctx.bundleDir, "skills", name, "SKILL.md"),
    targetPath: join(ctx.home, ctx.contract.skillsSubdir, name, "SKILL.md"),
  }));
}
