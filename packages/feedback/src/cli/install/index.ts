/**
 * The install-daemon dispatcher: picks an OS-specific writer by
 * `process.platform` and returns a portable plan the CLI can execute.
 *
 * Pure: no filesystem writes, no subprocess execs. The CLI orchestrates
 * the side effects so tests can cover platform routing without mutating
 * the host's supervision system.
 *
 * The plan also carries the supervisor-aware lifecycle data the CLI needs to
 * make `start`/`stop`/`restart` real: `serviceInstalledPath` (the path the CLI
 * stats to decide "is a service installed here") and the per-platform
 * `startCommands`/`stopCommands`/`restartCommands` lists. On macOS, `restart`
 * uses launchd's domain-target kickstart, which needs the user's uid; when no
 * `uid` is supplied in the context the restart list is empty, signalling that
 * the CLI cannot delegate a restart to the supervisor.
 */
import type { InstallContext } from "./linux.ts";
import {
  LINUX_INSTALL_COMMANDS,
  LINUX_RESTART_COMMANDS,
  LINUX_START_COMMANDS,
  LINUX_STOP_COMMANDS,
  LINUX_UNINSTALL_COMMANDS,
  linuxServiceContent,
  linuxServicePath,
} from "./linux.ts";
import {
  MACOS_START_COMMANDS,
  MACOS_STOP_COMMANDS,
  macosInstallCommands,
  macosRestartCommands,
  macosServiceContent,
  macosServicePath,
  macosUninstallCommands,
} from "./macos.ts";
import {
  WINDOWS_RESTART_COMMANDS,
  WINDOWS_START_COMMANDS,
  WINDOWS_STOP_COMMANDS,
  WINDOWS_UNINSTALL_COMMANDS,
  windowsInstallCommands,
  windowsServiceContent,
  windowsServicePath,
} from "./windows.ts";

export type { InstallContext };

/**
 * How the service file's bytes must be laid down on disk. The systemd unit and
 * the launchd plist are UTF-8; the Windows Task Scheduler XML must be UTF-16 LE
 * with a byte-order mark, because `schtasks /Create /XML` rejects UTF-8 input
 * with "unable to switch the encoding".
 */
export type ServiceFileEncoding = "utf-8" | "utf-16le-bom";

/**
 * Encode the service file content for the target platform. UTF-8 is a plain
 * byte encoding with no marker; "utf-16le-bom" prepends the BOM (0xFF 0xFE) and
 * encodes the rest as UTF-16 LE, the layout `schtasks` requires.
 */
export function serviceFileBytes(
  content: string,
  encoding: ServiceFileEncoding,
): Buffer {
  if (encoding === "utf-16le-bom") {
    const bom = String.fromCharCode(0xfeff);
    return Buffer.from(`${bom}${content}`, "utf16le");
  }
  return Buffer.from(content, "utf-8");
}

export interface InstallPlan {
  readonly servicePath: string;
  readonly serviceContent: string;
  readonly serviceFileEncoding: ServiceFileEncoding;
  readonly installCommands: ReadonlyArray<ReadonlyArray<string>>;
  readonly uninstallCommands: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * The path whose presence means "a service is installed here for this
   * platform". The CLI stats it to decide whether a lifecycle command should
   * drive the supervisor or fall back to flag-only semantics. Pure data: the
   * CLI does the stat, the planner never touches the filesystem.
   */
  readonly serviceInstalledPath: string;
  readonly startCommands: ReadonlyArray<ReadonlyArray<string>>;
  readonly stopCommands: ReadonlyArray<ReadonlyArray<string>>;
  readonly restartCommands: ReadonlyArray<ReadonlyArray<string>>;
}

export function planInstall(
  ctx: InstallContext,
  platform: NodeJS.Platform,
  home: string,
): InstallPlan {
  if (platform === "linux") {
    const servicePath = linuxServicePath(home);
    return {
      servicePath,
      serviceContent: linuxServiceContent(ctx),
      serviceFileEncoding: "utf-8",
      installCommands: LINUX_INSTALL_COMMANDS,
      uninstallCommands: LINUX_UNINSTALL_COMMANDS,
      serviceInstalledPath: servicePath,
      startCommands: LINUX_START_COMMANDS,
      stopCommands: LINUX_STOP_COMMANDS,
      restartCommands: LINUX_RESTART_COMMANDS,
    };
  }
  if (platform === "darwin") {
    const servicePath = macosServicePath(home);
    return {
      servicePath,
      serviceContent: macosServiceContent(ctx),
      serviceFileEncoding: "utf-8",
      installCommands: macosInstallCommands(servicePath),
      uninstallCommands: macosUninstallCommands(servicePath),
      serviceInstalledPath: servicePath,
      startCommands: MACOS_START_COMMANDS,
      stopCommands: MACOS_STOP_COMMANDS,
      restartCommands:
        ctx.uid === undefined ? [] : macosRestartCommands(ctx.uid),
    };
  }
  if (platform === "win32") {
    const servicePath = windowsServicePath(ctx.dataDir);
    return {
      servicePath,
      serviceContent: windowsServiceContent(ctx),
      serviceFileEncoding: "utf-16le-bom",
      installCommands: windowsInstallCommands(servicePath),
      uninstallCommands: WINDOWS_UNINSTALL_COMMANDS,
      serviceInstalledPath: servicePath,
      startCommands: WINDOWS_START_COMMANDS,
      stopCommands: WINDOWS_STOP_COMMANDS,
      restartCommands: WINDOWS_RESTART_COMMANDS,
    };
  }
  throw new Error(
    `regimen-feedback does not support automatic daemon install on platform "${platform}"`,
  );
}
