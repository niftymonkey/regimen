/**
 * The Guidance command facade: each command is an exported library function
 * taking a typed, already-parsed options object, the surface the unified
 * `regimen` CLI dispatches to in-process (ADR-0012). Guidance is the thinnest
 * lever: it has no deterministic mechanism to wire, so its whole install job is to
 * lay down the lever's own operator skill, the `guidance-respond` respond-step
 * helper, exactly as Feedback's install lays down its two skills and Enforcement's
 * lays down its one. There is NO gate wiring, NO emit, and no shipped catalog of
 * moves: an advisory move is the engineer's own, found or authored on demand by the
 * skill, never a Regimen product.
 *
 * The harness and its config home travel in the environment, not in options:
 * Guidance resolves the harness from REGIMEN_HARNESS (failing closed when it is
 * unset or unknown) and the config home from the env var the shared contract names
 * (e.g. CODEX_HOME), else the contract's default subdir under the user's home.
 * Guidance owns only its own skill: it never wires the capture hook (Feedback's
 * installer does that) and never touches a capture leaf, a gate, or a user hook.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type Harness,
  harnessContract,
  type HarnessContract,
  planSkillInstall,
  resolveHarnessFromEnvironment,
  resolveHarnessHome,
} from "@regimen/shared";
import { BUNDLED_SKILLS } from "../bundled-skills.ts";

/** The harness, its contract, and its config home a skill-install command targets, or null. */
interface SkillTarget {
  readonly contract: HarnessContract;
  /** The harness config home whose skills subdirectory receives the skills. */
  readonly home: string;
}

/** Resolve the harness with the shared per-invocation policy, or null with a diagnostic. */
function resolveHarness(): Harness | null {
  let harness;
  try {
    harness = resolveHarnessFromEnvironment(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return null;
  }
  if (harness === undefined) {
    process.stderr.write(
      "could not determine the harness; set REGIMEN_HARNESS or run Guidance from the harness CLI\n",
    );
    return null;
  }
  return harness;
}

/**
 * Resolve the harness, its contract, and its config home for skill install. Skills
 * install to the config home for EVERY harness (the harness discovers
 * `<configHome>/<skillsSubdir>/<name>/SKILL.md`). Fails closed with a stderr
 * diagnostic and a null return.
 */
function resolveSkillTarget(): SkillTarget | null {
  const harness = resolveHarness();
  if (harness === null) return null;
  const contract = harnessContract(harness);
  if (contract === undefined) {
    process.stderr.write(`no contract registered for harness: ${harness}\n`);
    return null;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (
    home === undefined &&
    process.env[contract.configHome.envVar] === undefined
  ) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return null;
  }
  return {
    contract,
    home: resolveHarnessHome(contract, process.env, home ?? ""),
  };
}

/** The repo root that holds Guidance's bundled `skills/` directory, two levels up. */
function bundleDir(): string {
  return resolve(import.meta.dir, "..", "..");
}

/**
 * Copy Guidance's bundled operator skill into the harness's skills subdirectory,
 * where the harness discovers it. The shared bundler resolves each skill's source
 * (from Guidance's OWN `bundleDir`) and harness-home target; Guidance passes its
 * own skill list so it bundles only `guidance-respond`, not Feedback's or
 * Enforcement's. `--dry-run` reports the targets without writing.
 */
export function installSkill(options: { dryRun: boolean }): number {
  const target = resolveSkillTarget();
  if (target === null) return 1;
  const plans = planSkillInstall({
    home: target.home,
    bundleDir: bundleDir(),
    contract: target.contract,
    skills: BUNDLED_SKILLS,
  });

  if (options.dryRun) {
    for (const plan of plans) {
      process.stdout.write(`would write ${plan.targetPath}\n`);
    }
    return 0;
  }
  for (const plan of plans) {
    mkdirSync(dirname(plan.targetPath), { recursive: true });
    copyFileSync(plan.sourcePath, plan.targetPath);
    process.stdout.write(`installed ${plan.targetPath}\n`);
  }
  return 0;
}

/**
 * Remove Guidance's bundled skill directory from the harness's skills subdirectory
 * (the inverse of install-skill). Reuses the bundler to locate each target. A
 * missing directory is not an error: uninstall must be idempotent. Best-effort per
 * skill: a removal that fails (e.g. a permission error) is reported and recorded,
 * but the loop continues to the remaining skills so a half-installed system can
 * always be cleaned up; the exit code is nonzero when any removal failed.
 */
export function uninstallSkill(options: { dryRun: boolean }): number {
  const target = resolveSkillTarget();
  if (target === null) return 1;
  let failed = 0;
  for (const plan of planSkillInstall({
    home: target.home,
    bundleDir: bundleDir(),
    contract: target.contract,
    skills: BUNDLED_SKILLS,
  })) {
    const skillDir = dirname(plan.targetPath);
    if (options.dryRun) {
      process.stdout.write(`would remove ${skillDir}\n`);
      continue;
    }
    try {
      rmSync(skillDir, { recursive: true, force: true });
      process.stdout.write(`removed ${skillDir}\n`);
    } catch (err) {
      failed = 1;
      process.stderr.write(
        `failed to remove ${skillDir}: ${(err as Error).message}\n`,
      );
    }
  }
  return failed;
}

/** The already-parsed options `install` acts on. */
export interface InstallOptions {
  /** Preview every step and write nothing. */
  readonly dryRun: boolean;
}

/**
 * `guidance install`: lay down the Guidance lever's operator skill. Guidance has no
 * deterministic mechanism to wire, so this is install's whole job: an advisory move
 * is the engineer's own, found or authored on demand by the `guidance-respond` skill
 * this step installs, not a Regimen product wired at install time. Honors
 * `--dry-run`. Runs on every OS (the bundled skill is a plain file).
 */
export function install(options: InstallOptions): number {
  process.stdout.write("Guidance install (respond-helper skill)\n");

  const skill = installSkill({ dryRun: options.dryRun });
  if (skill !== 0) return skill;

  process.stdout.write(
    options.dryRun
      ? "dry run complete; nothing was changed\n"
      : "Guidance skill installed\n",
  );
  return 0;
}

/** The already-parsed options `uninstall` acts on. */
export interface UninstallOptions {
  /** Preview every step and write nothing. */
  readonly dryRun: boolean;
}

/**
 * `guidance uninstall`: remove the Guidance operator skill. Best effort: a failing
 * step is recorded but the rest still run, so a half-installed system can always be
 * cleaned up. Honors `--dry-run`. There are no authored moves to tear down here:
 * an advisory move is the engineer's own, retired by the engineer where it lives.
 */
export function uninstall(options: UninstallOptions): number {
  process.stdout.write("Guidance uninstall\n");

  let failed = 0;
  if (uninstallSkill({ dryRun: options.dryRun }) !== 0) failed = 1;

  process.stdout.write(
    options.dryRun
      ? "dry run complete; nothing was changed\n"
      : "Guidance uninstalled\n",
  );
  return failed;
}
