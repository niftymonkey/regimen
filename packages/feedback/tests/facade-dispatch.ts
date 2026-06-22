/**
 * Test-support dispatch from a `feedback <command> [...flags]` argv to the
 * exported command facades (ADR-0012). The unified `regimen` CLI owns the real
 * argv parsing in production; this small dispatch lets the existing in-process
 * test helpers keep driving by argv while calling the facade functions directly,
 * so every assertion in the migrated suites stays verbatim. The dataDir comes
 * from `process.env.REGIMEN_DATA_DIR`, which these suites already pin. Unknown
 * commands and the no-command case are the dispatcher's concern (covered in
 * packages/cli/tests), so this support code only maps the known commands.
 */
import {
  assess,
  evidence,
  install,
  installDaemon,
  installSkill,
  list,
  purge,
  restart,
  start,
  status,
  stop,
  uninstall,
  uninstallDaemon,
  uninstallSkill,
  unwireHooks,
  wireHooks,
  type SessionFilter,
} from "../src/cli/index.ts";

/** Read a `--flag value` pair from argv, returning the value or undefined. */
function flagValue(
  args: ReadonlyArray<string>,
  flag: string,
): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Whether a boolean `--flag` is present in argv. */
function hasFlag(args: ReadonlyArray<string>, flag: string): boolean {
  return args.includes(flag);
}

/** Build the SessionFilter for `list` from its argv flags. */
function listFilter(args: ReadonlyArray<string>): SessionFilter {
  const harness = flagValue(args, "--harness");
  const model = flagValue(args, "--model");
  const since = flagValue(args, "--since");
  const until = flagValue(args, "--until");
  const outcome = flagValue(args, "--outcome");
  return {
    ...(harness !== undefined ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

/**
 * Drive one `feedback` command in-process by mapping its argv onto the matching
 * facade, awaiting the result (assess is async; awaiting a number is a no-op).
 * `argv` is the slice after `feedback`, i.e. `[command, ...flags]`.
 */
export async function dispatchFeedback(
  argv: ReadonlyArray<string>,
): Promise<number> {
  const [command, ...rest] = argv;
  const dataDir = process.env.REGIMEN_DATA_DIR ?? "";
  const dryRun = hasFlag(rest, "--dry-run");
  const session = flagValue(rest, "--session");

  switch (command) {
    case "start":
      return start({ dataDir, dryRun });
    case "stop":
      return stop({ dataDir, dryRun });
    case "restart":
      return restart({ dataDir, dryRun });
    case "status":
      return status({ dataDir });
    case "purge":
      return purge({
        dataDir,
        all: hasFlag(rest, "--all"),
        force: hasFlag(rest, "--force"),
      });
    case "evidence":
      return evidence(
        session !== undefined ? { dataDir, session } : { dataDir },
      );
    case "assess": {
      const judgeModel = flagValue(rest, "--judge-model");
      const judgeVia = flagValue(rest, "--judge-via");
      return assess({
        dataDir,
        ...(session !== undefined ? { session } : {}),
        ...(judgeModel !== undefined ? { judgeModel } : {}),
        ...(judgeVia === "cli" || judgeVia === "api" ? { judgeVia } : {}),
      });
    }
    case "list":
      return list({
        dataDir,
        filter: listFilter(rest),
        asJson: hasFlag(rest, "--json"),
      });
    case "install-daemon":
      return installDaemon({ dataDir, dryRun });
    case "uninstall-daemon":
      return uninstallDaemon({ dataDir, dryRun });
    case "install-skill":
      return installSkill({ dryRun });
    case "uninstall-skill":
      return uninstallSkill({ dryRun });
    case "wire-hooks":
      return wireHooks({ dryRun });
    case "unwire-hooks":
      return unwireHooks({ dryRun });
    case "install":
      return install({ dataDir, dryRun });
    case "uninstall":
      return uninstall({ dataDir, dryRun });
    default:
      throw new Error(
        `facade-dispatch: unmapped command "${String(command)}"; the dispatcher owns unknown-command handling (packages/cli/tests)`,
      );
  }
}
