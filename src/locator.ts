/**
 * The InstrumentLocator: resolve each Regimen instrument's CLI entry point on
 * the local filesystem, harness- and model-agnostic. This is the one deep
 * module of the hub: a small interface (locate one, or locate all) over a
 * first-hit-wins resolution chain (explicit flag, then env override, then the
 * named-sibling convention), followed by an existence-and-readability check.
 *
 * Dependency category 2: the only inputs are the filesystem and process.env.
 * No PATH lookup (feedback only `bun link`s during its own install and
 * enforcement never links, so PATH is unreliable for the first install and
 * ambiguous after), and no parent-directory scan for `regimen-*` (a scan trades
 * a legible failure for a wrong guess).
 */
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

export interface LocateResult {
  readonly entryPath: string;
}

export interface LocateError {
  readonly instrument: InstrumentName;
  readonly triedPath: string;
  readonly flag: string;
  readonly envVar: string;
  readonly message: string;
}

export type InstrumentName = "feedback" | "enforcement";

export interface LocatorOverrides {
  readonly feedbackPath?: string;
  readonly enforcementPath?: string;
}

export interface LocateContext {
  /** The hub's own clone root (the repo root, computed by the CLI from import.meta.dir). */
  readonly hubCloneRoot: string;
  /** The environment to read overrides from (injected so tests control it). */
  readonly env: Record<string, string | undefined>;
  readonly overrides: LocatorOverrides;
}

/**
 * The per-instrument knobs: the conventional sibling clone-dir name, the
 * override flag, the env var, and which override the caller passed by flag.
 * Small inline constants, no registry abstraction.
 */
interface InstrumentSpec {
  readonly conventionalDir: string;
  readonly flag: string;
  readonly envVar: string;
  readonly overrideOf: (overrides: LocatorOverrides) => string | undefined;
}

const SPECS: Record<InstrumentName, InstrumentSpec> = {
  feedback: {
    conventionalDir: "regimen-feedback",
    flag: "--feedback-path",
    envVar: "REGIMEN_FEEDBACK_PATH",
    overrideOf: (o) => o.feedbackPath,
  },
  enforcement: {
    conventionalDir: "regimen-enforcement",
    flag: "--enforcement-path",
    envVar: "REGIMEN_ENFORCEMENT_PATH",
    overrideOf: (o) => o.enforcementPath,
  },
};

/** The CLI entry sub-path appended to every resolved instrument clone root. */
const ENTRY_SUBPATH = join("src", "cli", "index.ts");

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one instrument. First hit wins: (1) explicit flag override pointing
 * at the clone root, (2) env override, (3) the named-sibling convention (the
 * hub clone root's parent dir plus the conventional sibling name). The chosen
 * clone root gets the known entry sub-path appended and is verified readable;
 * a miss returns a typed LocateError naming the instrument, the path tried, and
 * both override knobs so the message is actionable.
 */
export function locate(
  name: InstrumentName,
  ctx: LocateContext,
): LocateResult | LocateError {
  const spec = SPECS[name];

  const flagOverride = spec.overrideOf(ctx.overrides);
  const envOverride = ctx.env[spec.envVar];
  const cloneRoot =
    flagOverride !== undefined && flagOverride.length > 0
      ? flagOverride
      : envOverride !== undefined && envOverride.length > 0
        ? envOverride
        : join(dirname(ctx.hubCloneRoot), spec.conventionalDir);

  const entryPath = join(cloneRoot, ENTRY_SUBPATH);
  if (isReadableFile(entryPath)) return { entryPath };

  return {
    instrument: name,
    triedPath: entryPath,
    flag: spec.flag,
    envVar: spec.envVar,
    message: `could not locate the ${name} instrument: expected a readable CLI entry at ${entryPath}. Point the hub at its clone with ${spec.flag} <clone-root> or the ${spec.envVar} environment variable.`,
  };
}

/**
 * Resolve every required instrument, so a dry-run or preflight can report ALL
 * misses at once rather than only the first. Resolution is identical for
 * install and uninstall (the locator does not know the verb).
 */
export function locateAll(
  ctx: LocateContext,
): Map<InstrumentName, LocateResult | LocateError> {
  const out = new Map<InstrumentName, LocateResult | LocateError>();
  for (const name of Object.keys(SPECS) as InstrumentName[]) {
    out.set(name, locate(name, ctx));
  }
  return out;
}
