/**
 * The InstallPlan: a PURE function from an InstallConfig to an ordered list of
 * Steps the CLI will run, one per instrument. No I/O, no spawning, no
 * filesystem, no import.meta.dir: same config in, same plan out (dependency
 * category 1, the CLI's primary test surface).
 *
 * It names the instruments directly (no registry). Ordering is fixed so the
 * capture group lands ahead of the gate group on PreToolUse: install runs
 * feedback then enforcement (a denied tool call is still captured); uninstall
 * is the reverse (gates come down before capture). Each instrument's top-level
 * `install` / `uninstall` verb wires its own hooks internally, so the plan uses
 * no sub-verbs. Flag routing is the correctness core: shared flags forward to
 * every step, gate flags only to enforcement, cli-owned flags are consumed and
 * never forwarded.
 */
export type InstrumentName = "feedback" | "enforcement";

/** A step that shells out to one instrument's own install/uninstall verb. */
export interface InstrumentStep {
  readonly instrument: InstrumentName;
  readonly verb: string;
  readonly args: string[];
}

/**
 * The CLI's own self-link step: `bun link` (install) or `bun unlink`
 * (uninstall) of the CLI package, so that after the first run `regimen` is a
 * permanent bare command. It runs through the same runner and spawn seam as the
 * instrument steps, with cwd set to the CLI clone root, so it previews under
 * --dry-run and is covered by the recording-fake runner tests.
 */
export interface CliStep {
  readonly kind: "cli";
  readonly verb: "link" | "unlink";
}

export type Step = InstrumentStep | CliStep;

export interface InstallConfig {
  readonly dryRun: boolean;
  readonly gates: ReadonlyArray<string>;
  readonly noGates: boolean;
  readonly withBridge: boolean;
}

export function planInstall(config: InstallConfig): Step[] {
  return [
    {
      instrument: "feedback",
      verb: "install",
      args: argsFor("feedback", config),
    },
    {
      instrument: "enforcement",
      verb: "install",
      args: argsFor("enforcement", config),
    },
    { kind: "cli", verb: "link" },
  ];
}

export function planUninstall(config: InstallConfig): Step[] {
  return [
    { kind: "cli", verb: "unlink" },
    {
      instrument: "enforcement",
      verb: "uninstall",
      args: argsFor("enforcement", config),
    },
    {
      instrument: "feedback",
      verb: "uninstall",
      args: argsFor("feedback", config),
    },
  ];
}

/**
 * The args forwarded to one instrument's step, applying the flag-routing rules.
 * The shared flag (--dry-run) goes to every step; gate flags (--gate,
 * --no-gates) go only to enforcement. The harness and its config home are NOT
 * flags: they travel in the child environment, so no step carries --codex-home
 * or --harness. CLI-owned flags (--with-bridge) and the locator override flags
 * (--*-path) are consumed elsewhere and never appear here.
 */
function argsFor(instrument: InstrumentName, config: InstallConfig): string[] {
  const args: string[] = [];
  if (config.dryRun) args.push("--dry-run");
  if (instrument === "enforcement") {
    if (config.noGates) {
      args.push("--no-gates");
    } else {
      for (const gate of config.gates) args.push("--gate", gate);
    }
  }
  return args;
}
