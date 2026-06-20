#!/usr/bin/env bun
/**
 * The Enforcement CLI: `enforcement <command>`.
 *
 * Subcommands:
 *   install        wire the discipline gates into the harness's hooks file
 *   uninstall      remove Enforcement's gate entries (best effort)
 *   wire-gates     the gate-wiring step on its own
 *   unwire-gates   the gate-removal step on its own
 *
 * The harness and its config home travel in the environment, not in flags:
 * Enforcement resolves the harness from REGIMEN_HARNESS (failing closed when it
 * is unset or unknown) and the config home from the env var the shared contract
 * names (e.g. CODEX_HOME), else the contract's default subdir under the user's
 * home. Flags: --dry-run (preview every step, write nothing), --gate <id>
 * (repeatable), --no-gates. The default gate set is all three. The pure planner
 * owns the merge; this command owns the file read/write, the dry-run preview,
 * and the jq preflight. Enforcement owns gates only: it never wires the capture
 * hook (Feedback's installer does that) and never touches a capture leaf or a
 * user hook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Harness, harnessContract } from "@regimen/shared";
import { resolveHarness, resolveHarnessHome } from "../harness.ts";
import {
  type GateChange,
  type GateId,
  type HooksFile,
  planGateHooks,
  planGateHooksRemoval,
} from "../install/gate-hooks.ts";

export function runCli(argv: ReadonlyArray<string>): number {
  const command = argv[2];
  if (command === undefined) {
    process.stderr.write("usage: enforcement <command>\n");
    return 1;
  }
  if (command === "wire-gates") return wireGates(argv);
  if (command === "unwire-gates") return unwireGates(argv);
  if (command === "install") return install(argv);
  if (command === "uninstall") return uninstall(argv);
  process.stderr.write(`unknown command: ${command}\n`);
  return 1;
}

/** The gates wired by default (all three). */
const DEFAULT_GATES: ReadonlyArray<GateId> = [
  "rm-rf",
  "em-dash",
  "inline-message",
];

/** Gates that run as shell scripts and therefore need `jq` on PATH. */
const SHELL_GATES: ReadonlySet<string> = new Set(["em-dash", "inline-message"]);

/** Every value following a repeatable flag, in order. */
function collectFlagValues(
  argv: ReadonlyArray<string>,
  flag: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  }
  return out;
}

/**
 * The gate set to wire: `--no-gates` for none, one or more `--gate <id>` to
 * override, otherwise the default all-three set. Unknown ids are not rejected
 * here; the pure planner validates them and fails loudly.
 */
function parseGates(argv: ReadonlyArray<string>): GateId[] {
  if (argv.includes("--no-gates")) return [];
  const explicit = collectFlagValues(argv, "--gate");
  return explicit.length > 0 ? (explicit as GateId[]) : [...DEFAULT_GATES];
}

/** The harness and its config home a command targets, or null when it cannot be resolved. */
interface Target {
  readonly harness: Harness;
  readonly home: string;
}

/**
 * Resolve the harness from REGIMEN_HARNESS and its config home from the env var
 * the shared contract names (e.g. CODEX_HOME), else the contract's default
 * subdir under the user's home. Fails closed: a null return means REGIMEN_HARNESS
 * is unset, set to an unknown harness, has no registered contract, or the home
 * directory is undefined. Every failure writes a diagnostic to stderr first.
 */
function resolveTarget(): Target | null {
  let harness;
  try {
    harness = resolveHarness(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return null;
  }
  if (harness === undefined) {
    process.stderr.write(
      "REGIMEN_HARNESS is not set; Enforcement must be invoked with the harness in the environment\n",
    );
    return null;
  }
  const contract = harnessContract(harness);
  if (contract === undefined) {
    process.stderr.write(`no contract registered for harness: ${harness}\n`);
    return null;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined) {
    process.stderr.write("HOME (or USERPROFILE on Windows) is not set\n");
    return null;
  }
  return { harness, home: resolveHarnessHome(contract, process.env, home) };
}

/** The clone's absolute path: the repo root, two levels up from this file. */
function clonePath(): string {
  return join(import.meta.dir, "..", "..");
}

/** Read and parse the harness's hooks.json, or undefined when no file exists. */
function readHooksFile(path: string): HooksFile | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as HooksFile;
}

/** A one-line description of a gate change for the CLI to print. */
function describeChange(c: GateChange): string {
  return `gate ${c.id} on ${c.event}`;
}

/**
 * Warn (without failing) when shell gates are selected but `jq` is not on PATH:
 * the em-dash and inline-message gates parse the tool payload with `jq`, so they
 * cannot record a denial without it. The rm-rf gate runs under bun and is
 * unaffected. The deny still fires either way; only recording needs jq.
 */
function warnIfShellGateMissingJq(gates: ReadonlyArray<GateId>): void {
  const hasShellGate = gates.some((g) => SHELL_GATES.has(g));
  if (hasShellGate && Bun.which("jq") === null) {
    process.stderr.write(
      "warning: the em-dash and inline-message gates need `jq` on PATH to record denials, but jq was not found; install jq (brew install jq) or wire only --gate rm-rf\n",
    );
  }
}

/**
 * `enforcement wire-gates`. Merge the selected gates onto PreToolUse in the
 * harness's hooks.json idempotently, without clobbering the user's own hooks or
 * Feedback's capture leaf. The pure planner owns the merge; this owns the file
 * read/write and the dry-run preview.
 */
function wireGates(argv: ReadonlyArray<string>): number {
  const target = resolveTarget();
  if (target === null) return 1;
  const gates = parseGates(argv);
  const path = join(target.home, "hooks.json");

  let plan;
  try {
    plan = planGateHooks(readHooksFile(path), {
      clonePath: clonePath(),
      harness: target.harness,
      gates,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  warnIfShellGateMissingJq(gates);

  if (argv.includes("--dry-run")) {
    if (plan.added.length === 0) {
      process.stdout.write(`gates already wired in ${path}\n`);
    }
    for (const c of plan.added) {
      process.stdout.write(`would wire ${describeChange(c)}\n`);
    }
    return 0;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan.hooks, null, 2)}\n`);
  if (plan.added.length === 0) {
    process.stdout.write(`gates already wired in ${path}\n`);
  }
  for (const c of plan.added) {
    process.stdout.write(`wired ${describeChange(c)}\n`);
  }
  return 0;
}

/**
 * `enforcement unwire-gates`. Remove exactly Enforcement's gate entries from
 * the harness's hooks.json, leaving the user's hooks and Feedback's capture leaf
 * intact. Writes the pruned object back; the file is left in place even when
 * empty (the user may re-add their own hooks to it).
 */
function unwireGates(argv: ReadonlyArray<string>): number {
  const target = resolveTarget();
  if (target === null) return 1;
  const path = join(target.home, "hooks.json");
  if (!existsSync(path)) {
    process.stdout.write(`no hooks.json at ${path}; nothing to remove\n`);
    return 0;
  }

  let plan;
  try {
    plan = planGateHooksRemoval(readHooksFile(path));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (argv.includes("--dry-run")) {
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
 * `enforcement install`: wire the discipline gates. A thin orchestrator; today
 * the gate wiring is the only step, so this delegates to wire-gates and reports
 * the run boundary. Honors `--dry-run`, `--gate`, `--no-gates`.
 */
function install(argv: ReadonlyArray<string>): number {
  const dryRun = argv.includes("--dry-run");
  process.stdout.write("Enforcement install (discipline gates)\n");

  const gates = wireGates(argv);
  if (gates !== 0) return gates;

  process.stdout.write(
    dryRun
      ? "dry run complete; nothing was changed\n"
      : "Enforcement gates installed\n",
  );
  return 0;
}

/**
 * `enforcement uninstall`: remove Enforcement's gate entries. Best effort: a
 * failing step is recorded but the rest still run, so a half-installed system
 * can always be cleaned up. `||=` would short-circuit once `failed` is non-zero
 * and skip later teardown, so set the flag explicitly. Honors `--dry-run`.
 */
function uninstall(argv: ReadonlyArray<string>): number {
  process.stdout.write("Enforcement uninstall\n");
  let failed = 0;

  if (unwireGates(argv) !== 0) failed = 1;

  process.stdout.write(
    argv.includes("--dry-run")
      ? "dry run complete; nothing was changed\n"
      : "Enforcement uninstalled\n",
  );
  return failed;
}

if (import.meta.main) {
  process.exit(runCli(process.argv));
}
