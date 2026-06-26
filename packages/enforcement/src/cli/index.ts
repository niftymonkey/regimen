/**
 * The Enforcement command facade: each command is an exported library function
 * taking a typed, already-parsed options object, the surface the unified
 * `regimen` CLI dispatches to in-process (ADR-0012). With no shipped gate
 * catalog (author-on-demand, ADR-0012 plus the enforcement re-eval), the
 * lifecycle commands are `install`/`uninstall`, and their job is to lay down the
 * Enforcement lever's own operator skill, the `regimen-enforcement` respond-step
 * helper, exactly as Feedback's install lays down its two skills. They wire NO
 * gates: a gate is the engineer's own rule, authored on demand by the skill, not
 * a Regimen product.
 *
 * The authored-gate wiring path survives as a LIBRARY function, `wireAuthoredGate`,
 * the `regimen-enforcement` skill calls at AUTHORING time (when the engineer
 * confirms a gate), never at install time. It resolves the harness and its hooks
 * file, merges the authored gate onto the right per-harness pre-tool event through
 * the shared engine (`planGateHooks`), and writes, idempotently and without
 * clobbering the capture leaf or the user's own hooks.
 *
 * The harness and its config home travel in the environment, not in options:
 * Enforcement resolves the harness from REGIMEN_HARNESS (failing closed when it
 * is unset or unknown) and the config home from the env var the shared contract
 * names (e.g. CODEX_HOME), else the contract's default subdir under the user's
 * home. Enforcement owns gates and its own skill only: it never wires the capture
 * hook (Feedback's installer does that) and never touches a capture leaf or a
 * user hook.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Harness,
  harnessContract,
  type HarnessContract,
  type HooksFormat,
  planSkillInstall,
  resolveHarnessFromEnvironment,
  resolveHarnessHome,
} from "@regimen/shared";
import { BUNDLED_SKILLS } from "../bundled-skills.ts";
import {
  type AuthoredGate,
  type GateChange,
  type HooksFile,
  planGateHooks,
  planGateHooksRemoval,
} from "../install/gate-hooks.ts";

export type { GateId } from "../install/gate-hooks.ts";
export type { AuthoredGate } from "../install/gate-hooks.ts";

/** The harness and the resolved hooks file a gate-wiring command targets, or null when it cannot be resolved. */
interface Target {
  readonly harness: Harness;
  /** Absolute path to the harness's hooks file. */
  readonly hooksPath: string;
  /** The on-disk hooks format, so the remover strips the right structure. */
  readonly format: HooksFormat;
}

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
      "could not determine the harness; set REGIMEN_HARNESS or run Enforcement from the harness CLI\n",
    );
    return null;
  }
  return harness;
}

/**
 * Resolve the harness and the hooks file a gate is wired into. The file path is
 * the contract's per-harness relativePath joined under the resolved config home
 * (the env var the shared contract names, e.g. CODEX_HOME, else the contract's
 * default subdir under the user's home). Gemini is the one scope divergence
 * (ADR-0011, docs/harness-divergences.md): only a PROJECT-level
 * `.gemini/settings.json` fires headless, so its gates install under the current
 * workspace (`process.cwd()`), not the config home. Fails closed with a stderr
 * diagnostic and a null return.
 */
function resolveTarget(): Target | null {
  const harness = resolveHarness();
  if (harness === null) return null;
  const contract = harnessContract(harness);
  if (contract === undefined) {
    process.stderr.write(`no contract registered for harness: ${harness}\n`);
    return null;
  }
  const { relativePath, format } = contract.hooksFile;
  // The workspace is the current dir; Gemini's project-level scope is the only
  // divergence, and no flag is exposed for it. The project-level file is
  // `<cwd>/.gemini/settings.json`, so the config home's default subdir
  // (`.gemini`) prefixes the contract's relative hooks path.
  if (harness === "gemini") {
    return {
      harness,
      hooksPath: join(
        process.cwd(),
        contract.configHome.defaultSubdir,
        relativePath,
      ),
      format,
    };
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (
    home === undefined &&
    process.env[contract.configHome.envVar] === undefined
  ) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return null;
  }
  const configHome = resolveHarnessHome(contract, process.env, home ?? "");
  return {
    harness,
    hooksPath: join(configHome, relativePath),
    format,
  };
}

/**
 * Resolve the harness, its contract, and its config home for skill install. Unlike
 * the gate-wiring target, skills install to the config home for EVERY harness
 * (the harness discovers `<configHome>/<skillsSubdir>/<name>/SKILL.md`); Gemini's
 * project-level divergence applies to its hooks, not its skills. Fails closed with
 * a stderr diagnostic and a null return.
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

/** The clone's absolute path: the package root, two levels up from this file. */
function clonePath(): string {
  return resolve(import.meta.dir, "..", "..");
}

/** The repo root that holds Enforcement's bundled `skills/` directory, two levels up. */
function bundleDir(): string {
  return resolve(import.meta.dir, "..", "..");
}

/** Read and parse the harness's hooks.json, or undefined when no file exists. */
function readHooksFile(path: string): HooksFile | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as HooksFile;
}

/** A one-line description of a gate change for the caller to print. */
function describeChange(c: GateChange): string {
  return `gate ${c.id} on ${c.event}`;
}

/** The already-parsed options `wireAuthoredGate` acts on. */
export interface WireAuthoredGateOptions {
  /** The authored gate (the engineer's named rule plus its body path). */
  readonly gate: AuthoredGate;
  /** Preview every step and write nothing. */
  readonly dryRun: boolean;
}

/**
 * Wire one AUTHORED gate onto the harness's pre-tool boundary. This is the
 * library function the `regimen-enforcement` skill calls at authoring time, when
 * the engineer confirms a gate it drafted; it is NOT an install step. It resolves
 * the harness and hooks file, merges the gate idempotently through the shared
 * engine (without clobbering the user's own hooks or Feedback's capture leaf), and
 * writes. The pure planner owns the merge; this owns the file read/write and the
 * dry-run preview.
 */
export function wireAuthoredGate(options: WireAuthoredGateOptions): number {
  const target = resolveTarget();
  if (target === null) return 1;
  const path = target.hooksPath;

  let plan;
  try {
    plan = planGateHooks(readHooksFile(path), {
      clonePath: clonePath(),
      harness: target.harness,
      gates: [options.gate],
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (options.dryRun) {
    if (plan.added.length === 0) {
      process.stdout.write(`gate already wired in ${path}\n`);
    }
    for (const c of plan.added) {
      process.stdout.write(`would wire ${describeChange(c)}\n`);
    }
    return 0;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan.hooks, null, 2)}\n`);
  if (plan.added.length === 0) {
    process.stdout.write(`gate already wired in ${path}\n`);
  }
  for (const c of plan.added) {
    process.stdout.write(`wired ${describeChange(c)}\n`);
  }
  return 0;
}

/** The already-parsed options `unwireAuthoredGates` acts on. */
export interface UnwireAuthoredGatesOptions {
  /** Preview every step and write nothing. */
  readonly dryRun: boolean;
}

/**
 * Remove exactly Enforcement's gate entries from the harness's hooks.json, leaving
 * the user's hooks and Feedback's capture leaf intact. The library counterpart of
 * `wireAuthoredGate`, called when an authored gate is retired. Writes the pruned
 * object back; the file is left in place even when empty.
 */
export function unwireAuthoredGates(
  options: UnwireAuthoredGatesOptions,
): number {
  const target = resolveTarget();
  if (target === null) return 1;
  const path = target.hooksPath;
  if (!existsSync(path)) {
    process.stdout.write(`no hooks file at ${path}; nothing to remove\n`);
    return 0;
  }

  let plan;
  try {
    plan = planGateHooksRemoval(readHooksFile(path), target.format);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (options.dryRun) {
    if (plan.removed.length === 0) {
      process.stdout.write(`no Enforcement gates in ${path}\n`);
    }
    for (const c of plan.removed) {
      process.stdout.write(`would remove ${describeChange(c)}\n`);
    }
    return 0;
  }

  writeFileSync(path, `${JSON.stringify(plan.hooks, null, 2)}\n`);
  if (plan.removed.length === 0) {
    process.stdout.write(`no Enforcement gates in ${path}\n`);
  }
  for (const c of plan.removed) {
    process.stdout.write(`removed ${describeChange(c)}\n`);
  }
  return 0;
}

/**
 * Copy Enforcement's bundled operator skill into the harness's skills
 * subdirectory, where the harness discovers it. The shared bundler resolves each
 * skill's source (from Enforcement's OWN `bundleDir`) and harness-home target;
 * Enforcement passes its own skill list so it bundles only `regimen-enforcement`,
 * not Feedback's. `--dry-run` reports the targets without writing.
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
 * Remove Enforcement's bundled skill directory from the harness's skills
 * subdirectory (the inverse of install-skill). Reuses the bundler to locate each
 * target. A missing directory is not an error: uninstall must be idempotent.
 */
export function uninstallSkill(options: { dryRun: boolean }): number {
  const target = resolveSkillTarget();
  if (target === null) return 1;
  for (const plan of planSkillInstall({
    home: target.home,
    bundleDir: bundleDir(),
    contract: target.contract,
    skills: BUNDLED_SKILLS,
  })) {
    const skillDir = dirname(plan.targetPath);
    if (options.dryRun) {
      process.stdout.write(`would remove ${skillDir}\n`);
    } else {
      rmSync(skillDir, { recursive: true, force: true });
      process.stdout.write(`removed ${skillDir}\n`);
    }
  }
  return 0;
}

/** The already-parsed options `install` acts on. */
export interface InstallOptions {
  /** Preview every step and write nothing. */
  readonly dryRun: boolean;
}

/**
 * `enforcement install`: lay down the Enforcement lever's operator skill. With no
 * shipped gate catalog, this is install's whole job: a gate is the engineer's own
 * rule, authored on demand by the `regimen-enforcement` skill this step installs,
 * not a Regimen product wired at install time. Honors `--dry-run`. Runs on every
 * OS (the bundled skill is a plain file; there is no shell gate to skip on
 * Windows).
 */
export function install(options: InstallOptions): number {
  process.stdout.write("Enforcement install (respond-helper skill)\n");

  const skill = installSkill({ dryRun: options.dryRun });
  if (skill !== 0) return skill;

  process.stdout.write(
    options.dryRun
      ? "dry run complete; nothing was changed\n"
      : "Enforcement skill installed\n",
  );
  return 0;
}

/** The already-parsed options `uninstall` acts on. */
export interface UninstallOptions {
  /** Preview every step and write nothing. */
  readonly dryRun: boolean;
}

/**
 * `enforcement uninstall`: remove the Enforcement operator skill. Best effort: a
 * failing step is recorded but the rest still run, so a half-installed system can
 * always be cleaned up. Honors `--dry-run`. Authored gates are the engineer's own
 * and are retired through `unwireAuthoredGates`, not torn down here.
 */
export function uninstall(options: UninstallOptions): number {
  process.stdout.write("Enforcement uninstall\n");

  let failed = 0;
  if (uninstallSkill({ dryRun: options.dryRun }) !== 0) failed = 1;

  process.stdout.write(
    options.dryRun
      ? "dry run complete; nothing was changed\n"
      : "Enforcement uninstalled\n",
  );
  return failed;
}
