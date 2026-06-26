/**
 * The one surviving piece of the old gate-command catalog: the command-BUILDING
 * helper that turns an authored gate body into the shell command string a harness
 * hooks file runs. Enforcement ships NO catalog of fixed gate ids; the engineer's
 * own gate is authored on demand by the `enforcement-respond` skill, and this
 * helper is what wires the authored body onto the harness's pre-tool boundary.
 *
 * The command carries `REGIMEN_HARNESS=<harness>` so the running gate reads the
 * harness the installer detected rather than guessing, runs the body under `bun`
 * (the one runtime Regimen requires on every OS, so an authored gate is Windows-
 * safe without a shell or `jq`), forward-slashes the interpolated path so the
 * command survives a POSIX-style shell on native Windows (the same discipline
 * Feedback's capture command uses), and validates the forward-slashed path so a
 * path that could break out of the double-quoted shell context is rejected
 * loudly. Validation runs AFTER the forward-slash so a native-Windows path's
 * legitimate backslashes (turned to forward slashes) do not trip the shell-unsafe
 * check, while a genuinely dangerous `"`, `$`, or backtick still does.
 */
import { join } from "node:path";
import { assertSafeClonePath, type Harness } from "@regimen/shared";

/**
 * An authored gate's name. No longer a fixed union: the engineer names the gate
 * when the respond-helper authors it, so this is an open string.
 */
export type GateId = string;

/**
 * Build the shell command that runs an authored gate body. `clonePath` is the
 * absolute clone root the command is anchored against; `scriptPath` is the gate
 * body's path under that clone. The joined path is forward-slashed so it survives
 * a POSIX-style shell on native Windows, then validated so a shell-unsafe path is
 * rejected before it reaches the command string.
 */
export function buildGateCommand(
  clonePath: string,
  scriptPath: string,
  harness: Harness,
): string {
  const path = join(clonePath, scriptPath).replaceAll("\\", "/");
  assertSafeClonePath(path);
  return `REGIMEN_HARNESS=${harness} bun "${path}"`;
}
