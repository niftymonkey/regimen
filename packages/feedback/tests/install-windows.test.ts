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
});

test("windowsServiceContent quotes the cmd set assignment so REGIMEN_DATA_DIR carries no trailing space before &&", () => {
  const content = windowsServiceContent(CTX);
  const args = content.match(/<Arguments>([\s\S]*?)<\/Arguments>/);
  expect(args).not.toBeNull();
  const argsBody = args![1];
  expect(argsBody).toContain(`set "REGIMEN_DATA_DIR=${CTX.dataDir}"`);
  expect(argsBody).not.toContain(`set REGIMEN_DATA_DIR=`);
});

test("windowsServiceContent XML-escapes the command's & and > so the Arguments element is well-formed", () => {
  const content = windowsServiceContent(CTX);
  const args = content.match(/<Arguments>([\s\S]*?)<\/Arguments>/);
  expect(args).not.toBeNull();
  const argsBody = args![1];
  expect(argsBody).toContain("&amp;&amp;");
  expect(argsBody).toContain("&gt; NUL 2&gt;&amp;1");
  expect(argsBody).not.toContain(" && ");
  expect(argsBody).not.toContain("> NUL");
  expect(argsBody).not.toContain("2>&1");
});

test("windowsServiceContent XML-escapes special characters embedded in the data directory path", () => {
  const content = windowsServiceContent({
    ...CTX,
    dataDir: "C:\\Users\\R&D\\AppData\\Roaming\\regimen",
  });
  const args = content.match(/<Arguments>([\s\S]*?)<\/Arguments>/);
  expect(args).not.toBeNull();
  const argsBody = args![1];
  expect(argsBody).toContain("C:\\Users\\R&amp;D\\AppData\\Roaming\\regimen");
  expect(argsBody).not.toContain("R&D");
});

test("windowsServiceContent produces a well-formed document: every & opens a valid entity reference", () => {
  const content = windowsServiceContent({
    ...CTX,
    dataDir: "C:\\Users\\R&D\\AppData\\Roaming\\regimen",
  });
  const danglingAmpersand = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  expect(content).not.toMatch(danglingAmpersand);
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
