/**
 * The Linux install writer's pure behavior: unit file content and the path
 * it lives at. Side-effecting integration (writing the file, running
 * systemctl) lives in tests/install-cli.test.ts.
 */
import { expect, test } from "bun:test";
import {
  LINUX_INSTALL_COMMANDS,
  LINUX_RESTART_COMMANDS,
  LINUX_START_COMMANDS,
  LINUX_STOP_COMMANDS,
  LINUX_UNINSTALL_COMMANDS,
  linuxServiceContent,
  linuxServicePath,
  type InstallContext,
} from "../src/cli/install/linux.ts";

const CTX: InstallContext = {
  bunPath: "/home/mlo/.bun/bin/bun",
  loaderPath: "/home/mlo/dev/niftymonkey/regimen-feedback/src/loader/run.ts",
  dataDir: "/home/mlo/.local/share/regimen",
};

test("linuxServicePath resolves to ~/.config/systemd/user/regimen-feedback.service", () => {
  expect(linuxServicePath("/home/mlo")).toBe(
    "/home/mlo/.config/systemd/user/regimen-feedback.service",
  );
});

test("linuxServiceContent pins bun, loader, data dir, and restart policy", () => {
  const content = linuxServiceContent(CTX);
  expect(content).toContain("[Unit]");
  expect(content).toContain("[Service]");
  expect(content).toContain("[Install]");
  expect(content).toContain(`ExecStart=${CTX.bunPath} ${CTX.loaderPath}`);
  expect(content).toContain(`Environment=REGIMEN_DATA_DIR=${CTX.dataDir}`);
  expect(content).toContain("Restart=on-failure");
  expect(content).toContain("StandardOutput=null");
  expect(content).toContain("StandardError=null");
  expect(content).toContain("WantedBy=default.target");
});

test("LINUX_INSTALL_COMMANDS reloads units and enables the service", () => {
  expect(LINUX_INSTALL_COMMANDS).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "regimen-feedback.service"],
  ]);
});

test("LINUX_UNINSTALL_COMMANDS disables and stops the service", () => {
  expect(LINUX_UNINSTALL_COMMANDS).toEqual([
    ["systemctl", "--user", "disable", "--now", "regimen-feedback.service"],
  ]);
});

test("LINUX_START_COMMANDS asks systemd to start the unit", () => {
  expect(LINUX_START_COMMANDS).toEqual([
    ["systemctl", "--user", "start", "regimen-feedback.service"],
  ]);
});

test("LINUX_STOP_COMMANDS asks systemd to stop the unit", () => {
  expect(LINUX_STOP_COMMANDS).toEqual([
    ["systemctl", "--user", "stop", "regimen-feedback.service"],
  ]);
});

test("LINUX_RESTART_COMMANDS delegates to systemd's own restart so the replacement runs current code", () => {
  expect(LINUX_RESTART_COMMANDS).toEqual([
    ["systemctl", "--user", "restart", "regimen-feedback.service"],
  ]);
});
