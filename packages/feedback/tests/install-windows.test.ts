/**
 * The Windows install writer's pure behavior: Task Scheduler XML content,
 * path under the data directory, and the schtasks command shape. End-to-end
 * verification requires Windows and is not run from this WSL test suite.
 */
import { expect, test } from "bun:test";
import {
  WINDOWS_RESTART_COMMANDS,
  WINDOWS_START_COMMANDS,
  WINDOWS_STOP_COMMANDS,
  WINDOWS_TASK_NAME,
  WINDOWS_UNINSTALL_COMMANDS,
  windowsInstallCommands,
  windowsServiceContent,
  windowsServicePath,
} from "../src/cli/install/windows.ts";
import type { InstallContext } from "../src/cli/install/linux.ts";

const CTX: InstallContext = {
  bunPath: "C:\\Users\\mlo\\.bun\\bin\\bun.exe",
  loaderPath: "C:\\Users\\mlo\\dev\\regimen-feedback\\src\\loader\\run.ts",
  dataDir: "C:\\Users\\mlo\\AppData\\Roaming\\regimen",
};

test("windowsServicePath places the task XML inside the data directory", () => {
  expect(windowsServicePath(CTX.dataDir)).toBe(
    "C:\\Users\\mlo\\AppData\\Roaming\\regimen\\regimen-feedback.task.xml",
  );
});

test("windowsServiceContent wraps bun in cmd.exe to set REGIMEN_DATA_DIR, pins paths, and configures logon trigger plus restart-on-failure", () => {
  const content = windowsServiceContent(CTX);
  expect(content).toContain("<?xml");
  expect(content).toContain('encoding="UTF-16"');
  expect(content).toContain("<Task");
  expect(content).toContain("<LogonTrigger>");
  expect(content).toContain("<RestartOnFailure>");
  expect(content).toContain("<Command>cmd.exe</Command>");
  expect(content).toContain(CTX.bunPath);
  expect(content).toContain(CTX.loaderPath);
  expect(content).toContain(`REGIMEN_DATA_DIR=${CTX.dataDir}`);
  expect(content).toContain("> NUL 2>&1");
});

test("windowsInstallCommands register the task via schtasks /create", () => {
  const xmlPath =
    "C:\\Users\\mlo\\AppData\\Roaming\\regimen\\regimen-feedback.task.xml";
  expect(windowsInstallCommands(xmlPath)).toEqual([
    ["schtasks", "/Create", "/TN", WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"],
  ]);
});

test("WINDOWS_UNINSTALL_COMMANDS remove the task via schtasks /delete", () => {
  expect(WINDOWS_UNINSTALL_COMMANDS).toEqual([
    ["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"],
  ]);
});

test("WINDOWS_START_COMMANDS run the scheduled task now", () => {
  expect(WINDOWS_START_COMMANDS).toEqual([
    ["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME],
  ]);
});

test("WINDOWS_STOP_COMMANDS end the running task instance", () => {
  expect(WINDOWS_STOP_COMMANDS).toEqual([
    ["schtasks", "/End", "/TN", WINDOWS_TASK_NAME],
  ]);
});

test("WINDOWS_RESTART_COMMANDS end then re-run the task so the replacement runs current code", () => {
  expect(WINDOWS_RESTART_COMMANDS).toEqual([
    ["schtasks", "/End", "/TN", WINDOWS_TASK_NAME],
    ["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME],
  ]);
});
