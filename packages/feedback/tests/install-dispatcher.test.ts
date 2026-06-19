/**
 * The install-daemon dispatcher's platform routing. Pure: takes platform
 * and home as parameters so tests can exercise every branch.
 */
import { expect, test } from "bun:test";
import { planInstall } from "../src/cli/install/index.ts";
import type { InstallContext } from "../src/cli/install/linux.ts";

const CTX: InstallContext = {
  bunPath: "/usr/local/bin/bun",
  loaderPath: "/repo/src/loader/run.ts",
  dataDir: "/home/test/.local/share/regimen",
};

test("linux routes to systemd --user", () => {
  const plan = planInstall(CTX, "linux", "/home/test");
  expect(plan.servicePath).toContain("systemd/user");
  expect(plan.serviceContent).toContain("[Service]");
  expect(plan.installCommands[0]?.[0]).toBe("systemctl");
});

test("darwin routes to launchd LaunchAgent", () => {
  const plan = planInstall(CTX, "darwin", "/Users/test");
  expect(plan.servicePath).toContain("Library/LaunchAgents");
  expect(plan.serviceContent).toContain("<plist");
  expect(plan.installCommands[0]?.[0]).toBe("launchctl");
});

test("win32 routes to Task Scheduler", () => {
  const winCtx: InstallContext = {
    ...CTX,
    dataDir: "C:\\Users\\test\\AppData\\Roaming\\regimen",
  };
  const plan = planInstall(winCtx, "win32", "C:\\Users\\test");
  expect(plan.servicePath).toContain("regimen-feedback.task.xml");
  expect(plan.serviceContent).toContain("<Task");
  expect(plan.installCommands[0]?.[0]).toBe("schtasks");
});

test("an unsupported platform throws a clear error", () => {
  expect(() => planInstall(CTX, "freebsd", "/home/test")).toThrow(
    /does not support automatic daemon install/,
  );
});

test("the linux plan carries the unit path as its install marker and systemctl lifecycle commands", () => {
  const plan = planInstall(CTX, "linux", "/home/test");
  expect(plan.serviceInstalledPath).toBe(plan.servicePath);
  expect(plan.startCommands).toEqual([
    ["systemctl", "--user", "start", "regimen-feedback.service"],
  ]);
  expect(plan.stopCommands).toEqual([
    ["systemctl", "--user", "stop", "regimen-feedback.service"],
  ]);
  expect(plan.restartCommands).toEqual([
    ["systemctl", "--user", "restart", "regimen-feedback.service"],
  ]);
});

test("the windows plan carries the task XML path as its install marker and schtasks lifecycle commands", () => {
  const winCtx: InstallContext = {
    ...CTX,
    dataDir: "C:\\Users\\test\\AppData\\Roaming\\regimen",
  };
  const plan = planInstall(winCtx, "win32", "C:\\Users\\test");
  expect(plan.serviceInstalledPath).toBe(plan.servicePath);
  expect(plan.startCommands).toEqual([
    ["schtasks", "/Run", "/TN", "regimen-feedback"],
  ]);
  expect(plan.stopCommands).toEqual([
    ["schtasks", "/End", "/TN", "regimen-feedback"],
  ]);
  expect(plan.restartCommands).toEqual([
    ["schtasks", "/End", "/TN", "regimen-feedback"],
    ["schtasks", "/Run", "/TN", "regimen-feedback"],
  ]);
});

test("the darwin plan carries the plist path as its install marker and launchctl lifecycle commands scoped to the context uid", () => {
  const plan = planInstall({ ...CTX, uid: 501 }, "darwin", "/Users/test");
  expect(plan.serviceInstalledPath).toBe(plan.servicePath);
  expect(plan.startCommands).toEqual([
    ["launchctl", "start", "dev.niftymonkey.regimen-feedback"],
  ]);
  expect(plan.stopCommands).toEqual([
    ["launchctl", "stop", "dev.niftymonkey.regimen-feedback"],
  ]);
  expect(plan.restartCommands).toEqual([
    [
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/dev.niftymonkey.regimen-feedback",
    ],
  ]);
});
