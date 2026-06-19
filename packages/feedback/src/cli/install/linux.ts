/**
 * The Linux install writer: a systemd `--user` unit that supervises the
 * Feedback loader. Pure: produces the unit-file content and resolves the
 * file path under `~/.config/systemd/user/`. The CLI orchestrates the
 * actual file write and the `systemctl --user` invocations.
 *
 * The unit pins the loader's absolute path, the `bun` runtime, and the
 * Regimen data directory at install time so the supervised process is
 * unambiguous regardless of how the user's shell environment differs.
 *
 * `Restart=on-failure` agrees with the loader's clean-exit contract: a
 * flag-driven shutdown is a clean exit (code 0), so systemd treats a
 * deliberate `feedback stop` as a successful exit and leaves the unit
 * stopped. `feedback start` then asks systemd to start it again; only a crash
 * (nonzero exit) triggers an automatic restart.
 *
 * The daemon writes and bounds its own `daemon.log`, so the unit sends the
 * process's stdout and stderr to `null` rather than appending them to a file
 * nothing would ever rotate.
 */
import { join } from "node:path";

export interface InstallContext {
  readonly bunPath: string;
  readonly loaderPath: string;
  readonly dataDir: string;
  /**
   * The user's numeric uid, used only by the macOS planner to scope the
   * launchd `gui/<uid>` domain target for `restart`. Posix-only and absent on
   * Windows; the macOS planner is the sole reader and treats a missing uid as
   * "cannot build a restart command list".
   */
  readonly uid?: number;
}

export function linuxServiceContent(ctx: InstallContext): string {
  return `[Unit]
Description=Regimen Feedback loader
Documentation=https://github.com/niftymonkey/regimen
After=default.target

[Service]
Type=simple
ExecStart=${ctx.bunPath} ${ctx.loaderPath}
Environment=REGIMEN_DATA_DIR=${ctx.dataDir}
Restart=on-failure
RestartSec=2
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
}

export function linuxServicePath(home: string): string {
  return join(home, ".config", "systemd", "user", "regimen-feedback.service");
}

export const LINUX_INSTALL_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["systemctl", "--user", "daemon-reload"],
  ["systemctl", "--user", "enable", "--now", "regimen-feedback.service"],
];

export const LINUX_UNINSTALL_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["systemctl", "--user", "disable", "--now", "regimen-feedback.service"],
];

export const LINUX_START_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["systemctl", "--user", "start", "regimen-feedback.service"],
];

export const LINUX_STOP_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["systemctl", "--user", "stop", "regimen-feedback.service"],
];

export const LINUX_RESTART_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["systemctl", "--user", "restart", "regimen-feedback.service"],
];
