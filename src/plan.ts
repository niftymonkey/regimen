/**
 * The InstallPlan: a PURE function from an InstallConfig to an ordered list of
 * Steps the hub will run, one per instrument. No I/O, no spawning, no
 * filesystem, no import.meta.dir: same config in, same plan out (dependency
 * category 1, the hub's primary test surface).
 *
 * It names the instruments directly (no registry). Ordering is fixed so the
 * capture group lands ahead of the gate group on PreToolUse: install runs
 * feedback then enforcement (a denied tool call is still captured); uninstall
 * is the reverse (gates come down before capture). Each instrument's top-level
 * `install` / `uninstall` verb wires its own hooks internally, so the plan uses
 * no sub-verbs. Flag routing is the correctness core: shared flags forward to
 * every step, gate flags only to enforcement, hub-owned flags are consumed and
 * never forwarded.
 */
export type InstrumentName = "feedback" | "enforcement";

export interface Step {
  readonly instrument: InstrumentName;
  readonly verb: string;
  readonly args: string[];
}

export interface InstallConfig {
  readonly dryRun: boolean;
  readonly codexHome?: string;
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
  ];
}

export function planUninstall(config: InstallConfig): Step[] {
  return [
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
 * Shared flags (--dry-run, --codex-home) go to every step; gate flags (--gate,
 * --no-gates) go only to enforcement. Hub-owned flags (--with-bridge) and the
 * locator override flags (--*-path) are consumed elsewhere and never appear
 * here.
 */
function argsFor(instrument: InstrumentName, config: InstallConfig): string[] {
  const args: string[] = [];
  if (config.dryRun) args.push("--dry-run");
  if (config.codexHome !== undefined) {
    args.push("--codex-home", config.codexHome);
  }
  if (instrument === "enforcement") {
    if (config.noGates) {
      args.push("--no-gates");
    } else {
      for (const gate of config.gates) args.push("--gate", gate);
    }
  }
  return args;
}
