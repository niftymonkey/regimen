#!/usr/bin/env bun
/**
 * The Regimen CLI: `regimen install` / `regimen uninstall`. A thin
 * composition root with no hidden depth: it parses argv, asks the locator to
 * resolve every instrument (failing with a distinct nonzero BEFORE any spawn if
 * one is missing), builds the pure plan, prints the CLI's composition, then
 * hands the plan and the located paths to the runner with the real spawn. The
 * depth lives in the locator and the planner; the CLI holds no logic worth deep
 * testing.
 *
 * Harness- and model-agnostic: it spawns each instrument's CLI as a subprocess
 * and forwards exit codes; it never imports any instrument internals. The CLI
 * orchestrates Feedback and Enforcement today; the bridge is a reserved future
 * (--with-bridge is parsed and consumed but adds no step yet).
 */
import { dirname } from "node:path";
import {
  type InstrumentName,
  type LocateError,
  type LocateResult,
  type LocatorOverrides,
  locateAll,
} from "../locator.ts";
import {
  type InstallConfig,
  type Step,
  planInstall,
  planUninstall,
} from "../plan.ts";
import { realSpawn, runSteps } from "../runner.ts";

export type Verb = "install" | "uninstall";

export interface ParsedArgs {
  readonly verb: Verb;
  readonly config: InstallConfig;
  readonly overrides: LocatorOverrides;
}

/** The value following `flag` in `argv`, or undefined if absent or last. */
function flagValue(
  argv: ReadonlyArray<string>,
  flag: string,
): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

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

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const verb = argv[0];
  if (verb !== "install" && verb !== "uninstall") {
    throw new Error(`usage: regimen <install|uninstall> [flags]`);
  }

  const feedbackPath = flagValue(argv, "--feedback-path");
  const enforcementPath = flagValue(argv, "--enforcement-path");

  const config: InstallConfig = {
    dryRun: argv.includes("--dry-run"),
    gates: collectFlagValues(argv, "--gate"),
    noGates: argv.includes("--no-gates"),
    withBridge: argv.includes("--with-bridge"),
  };

  const overrides: LocatorOverrides = {
    ...(feedbackPath !== undefined ? { feedbackPath } : {}),
    ...(enforcementPath !== undefined ? { enforcementPath } : {}),
  };

  return { verb, config, overrides };
}

/** The distinct exit code for a missing-instrument locator miss, before any spawn. */
const EXIT_LOCATE_MISS = 2;

function isLocateError(
  value: LocateResult | LocateError,
): value is LocateError {
  return "message" in value;
}

export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  const { verb, config, overrides } = parsed;

  process.stdout.write(
    verb === "install"
      ? "Regimen install (Feedback + Enforcement)\n"
      : "Regimen uninstall\n",
  );

  // locateAll runs for real even in dry-run (it is read-only), so a dry run
  // surfaces missing-instrument errors exactly as a wet run would, before any
  // subprocess spawns.
  const cliRoot = cliPackageRoot();
  const located = locateAll({
    cliPackageRoot: cliRoot,
    env: process.env,
    overrides,
  });
  const misses = [...located.values()].filter(isLocateError);
  if (misses.length > 0) {
    for (const miss of misses) process.stderr.write(`${miss.message}\n`);
    return EXIT_LOCATE_MISS;
  }

  const entryPaths = new Map<InstrumentName, string>();
  const cloneRoots = new Map<InstrumentName, string>();
  for (const [name, result] of located) {
    if (!isLocateError(result)) {
      entryPaths.set(name, result.entryPath);
      cloneRoots.set(name, result.cloneRoot);
    }
  }

  const steps =
    verb === "install" ? planInstall(config) : planUninstall(config);
  printPlan(steps, entryPaths, cliRoot);

  const childEnv = harnessChildEnv(process.env);
  const result = await runSteps(steps, entryPaths, cloneRoots, {
    spawn: realSpawn,
    failFast: verb === "install",
    cliPackageRoot: cliRoot,
    dryRun: config.dryRun,
    ...(childEnv !== undefined ? { childEnv } : {}),
  });
  return result.exitCode;
}

/**
 * The environment overlay the CLI hands each instrument child: the harness
 * identity as an opaque REGIMEN_HARNESS string, copied from the CLI's own
 * environment, so a child resolves its own harness without the CLI importing any
 * instrument internals or forwarding a --harness flag. Returns undefined when
 * REGIMEN_HARNESS is unset or empty, leaving the child to inherit the parent
 * environment unchanged (each instrument fails closed on its own if it then
 * cannot resolve a harness). Pure: same env in, same overlay out.
 */
export function harnessChildEnv(
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const harness = env.REGIMEN_HARNESS;
  if (typeof harness !== "string" || harness.length === 0) return undefined;
  return { REGIMEN_HARNESS: harness };
}

/**
 * Print the CLI's computed plan so the user sees the composition before any
 * child runs: each instrument step's instrument, verb, resolved entry path, and
 * args, plus the CLI's own self-link step (`bun link`/`bun unlink` at the CLI
 * clone root), in order. Both layers preview under --dry-run (the CLI prints
 * this plan and each child still runs with --dry-run in its args; the CLI
 * self-link is previewed here and not spawned under --dry-run).
 */
function printPlan(
  steps: ReadonlyArray<Step>,
  entryPaths: ReadonlyMap<InstrumentName, string>,
  cliRoot: string,
): void {
  process.stdout.write("plan:\n");
  for (const step of steps) {
    if ("kind" in step) {
      process.stdout.write(`  cli: bun ${step.verb} (cwd ${cliRoot})\n`);
      continue;
    }
    const entry = entryPaths.get(step.instrument) ?? "(unresolved)";
    const argsText = step.args.length > 0 ? ` ${step.args.join(" ")}` : "";
    process.stdout.write(
      `  ${step.instrument}: bun ${entry} ${step.verb}${argsText}\n`,
    );
  }
}

/** The cli package's own root, two levels up from this file. */
export function cliPackageRoot(): string {
  return dirname(dirname(import.meta.dir));
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
