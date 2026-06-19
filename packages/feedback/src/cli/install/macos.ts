/**
 * The macOS install writer: a launchd LaunchAgent plist that supervises
 * the Feedback loader. Pure: produces the plist XML and resolves the file
 * path under `~/Library/LaunchAgents/`. The CLI orchestrates the actual
 * file write and the `launchctl` invocations.
 *
 * The daemon writes and bounds its own `daemon.log`, so the plist points
 * stdout and stderr at `/dev/null` rather than at a file nothing would ever
 * rotate.
 *
 * `KeepAlive` is a dict gated on `SuccessfulExit=false`, not an unconditional
 * `true`. The loader's flag-driven shutdown is a clean exit (code 0), so a
 * deliberate `feedback stop` leaves the service stopped instead of triggering
 * a relaunch that immediately re-exits on the missing flag. Only a crash
 * (nonzero exit) revives the daemon, which is what supervision is for.
 */
import { join } from "node:path";
import type { InstallContext } from "./linux.ts";

export const MACOS_LABEL = "dev.niftymonkey.regimen-feedback";
const LABEL = MACOS_LABEL;

export function macosServiceContent(ctx: InstallContext): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${ctx.bunPath}</string>
    <string>${ctx.loaderPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REGIMEN_DATA_DIR</key>
    <string>${ctx.dataDir}</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

export function macosServicePath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function macosInstallCommands(
  servicePath: string,
): ReadonlyArray<ReadonlyArray<string>> {
  return [["launchctl", "load", "-w", servicePath]];
}

export function macosUninstallCommands(
  servicePath: string,
): ReadonlyArray<ReadonlyArray<string>> {
  return [["launchctl", "unload", servicePath]];
}

export const MACOS_START_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["launchctl", "start", LABEL],
];

export const MACOS_STOP_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["launchctl", "stop", LABEL],
];

/**
 * launchd has no by-label restart, so the modern domain-target form is used:
 * `kickstart -k` kills the running instance and starts a fresh one in one
 * call, which is what makes a restart run current code. The user's `uid`
 * scopes the per-user `gui` domain target.
 */
export function macosRestartCommands(
  uid: number,
): ReadonlyArray<ReadonlyArray<string>> {
  return [["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`]];
}
