/**
 * The Windows install writer: a Task Scheduler XML file that supervises
 * the Feedback loader on user logon, with restart-on-failure. Pure:
 * produces the XML content, the path the XML lives at (under the data
 * directory), and the `schtasks` invocations to register and remove the
 * task. The CLI orchestrates the actual file write and the `schtasks`
 * invocations.
 *
 * The Exec action wraps `cmd.exe` so that `REGIMEN_DATA_DIR` can be set
 * for the supervised process. Task Scheduler does not expose environment
 * variables on the Exec action directly; the shell wrap is the
 * conventional escape.
 *
 * The daemon writes and bounds its own `daemon.log`, so the wrapped command
 * sends stdout and stderr to `NUL` rather than appending them to a file
 * nothing would ever rotate.
 *
 * `RestartOnFailure` agrees with the loader's clean-exit contract: the
 * flag-driven shutdown is a clean exit (code 0), so a deliberate
 * `feedback stop` leaves the task stopped, and `feedback start` re-runs it.
 * Only a crash (nonzero exit) triggers an automatic restart, mirroring the
 * systemd `Restart=on-failure` and launchd `KeepAlive`-on-unsuccessful-exit
 * shapes on the other platforms.
 */
import { win32 as pathWin32 } from "node:path";
import type { InstallContext } from "./linux.ts";

export const WINDOWS_TASK_NAME = "regimen-feedback";
const TASK_XML_NAME = "regimen-feedback.task.xml";

/**
 * Escape XML text-content metacharacters so dynamic command content is safe to
 * embed in the Task Scheduler XML. `&` is escaped first so the `&amp;`, `&lt;`,
 * and `&gt;` entities introduced here are not themselves re-escaped. schtasks
 * unescapes these back to the literal command at run time.
 */
function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function windowsServiceContent(ctx: InstallContext): string {
  const inner = `set "REGIMEN_DATA_DIR=${ctx.dataDir}" && "${ctx.bunPath}" "${ctx.loaderPath}" > NUL 2>&1`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Regimen Feedback loader</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape("cmd.exe")}</Command>
      <Arguments>${xmlEscape(`/c "${inner}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function windowsServicePath(dataDir: string): string {
  return pathWin32.join(dataDir, TASK_XML_NAME);
}

export function windowsInstallCommands(
  servicePath: string,
): ReadonlyArray<ReadonlyArray<string>> {
  return [
    [
      "schtasks",
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/XML",
      servicePath,
      "/F",
    ],
  ];
}

export const WINDOWS_UNINSTALL_COMMANDS: ReadonlyArray<ReadonlyArray<string>> =
  [["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]];

export const WINDOWS_START_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME],
];

export const WINDOWS_STOP_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["schtasks", "/End", "/TN", WINDOWS_TASK_NAME],
];

export const WINDOWS_RESTART_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["schtasks", "/End", "/TN", WINDOWS_TASK_NAME],
  ["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME],
];
