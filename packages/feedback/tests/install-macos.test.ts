/**
 * The macOS install writer's pure behavior: launchd plist content, path,
 * and the load/unload command shape. End-to-end verification requires
 * macOS hardware and is not run from this WSL test suite.
 */
import { expect, test } from "bun:test";
import {
  MACOS_LABEL,
  MACOS_START_COMMANDS,
  MACOS_STOP_COMMANDS,
  macosInstallCommands,
  macosRestartCommands,
  macosServiceContent,
  macosServicePath,
  macosUninstallCommands,
} from "../src/cli/install/macos.ts";
import type { InstallContext } from "../src/cli/install/linux.ts";

const CTX: InstallContext = {
  bunPath: "/Users/mlo/.bun/bin/bun",
  loaderPath: "/Users/mlo/dev/regimen-feedback/src/loader/run.ts",
  dataDir: "/Users/mlo/Library/Application Support/regimen",
};

test("macosServicePath resolves to ~/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist", () => {
  expect(macosServicePath("/Users/mlo")).toBe(
    "/Users/mlo/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist",
  );
});

test("macosServiceContent is a valid plist that pins bun, loader, data dir, and KeepAlive", () => {
  const content = macosServiceContent(CTX);
  expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(content).toContain("<plist");
  expect(content).toContain(
    "<key>Label</key>\n  <string>dev.niftymonkey.regimen-feedback</string>",
  );
  expect(content).toContain(`<string>${CTX.bunPath}</string>`);
  expect(content).toContain(`<string>${CTX.loaderPath}</string>`);
  expect(content).toContain("<key>REGIMEN_DATA_DIR</key>");
  expect(content).toContain(`<string>${CTX.dataDir}</string>`);
  expect(content).toContain("<key>RunAtLoad</key>\n  <true/>");
  expect(content).toContain(
    "<key>StandardOutPath</key>\n  <string>/dev/null</string>",
  );
  expect(content).toContain(
    "<key>StandardErrorPath</key>\n  <string>/dev/null</string>",
  );
});

test("macosServiceContent keeps the daemon alive only on unsuccessful exit so a deliberate stop stays stopped", () => {
  const content = macosServiceContent(CTX);
  // KeepAlive is a dict gated on SuccessfulExit=false: the loader's flag-driven
  // shutdown is a clean exit (code 0), so launchd treats it as successful and
  // does not relaunch. Only a crash (nonzero) revives the daemon.
  expect(content).toContain(
    "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>",
  );
  expect(content).not.toContain("<key>KeepAlive</key>\n  <true/>");
});

test("macosInstallCommands load the plist via launchctl", () => {
  expect(
    macosInstallCommands(
      "/Users/mlo/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist",
    ),
  ).toEqual([
    [
      "launchctl",
      "load",
      "-w",
      "/Users/mlo/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist",
    ],
  ]);
});

test("macosUninstallCommands unload the plist via launchctl", () => {
  expect(
    macosUninstallCommands(
      "/Users/mlo/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist",
    ),
  ).toEqual([
    [
      "launchctl",
      "unload",
      "/Users/mlo/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist",
    ],
  ]);
});

test("MACOS_START_COMMANDS run the loaded job by label", () => {
  expect(MACOS_START_COMMANDS).toEqual([["launchctl", "start", MACOS_LABEL]]);
});

test("MACOS_STOP_COMMANDS stop the running job by label", () => {
  expect(MACOS_STOP_COMMANDS).toEqual([["launchctl", "stop", MACOS_LABEL]]);
});

test("macosRestartCommands kickstart-restart the job in the user gui domain so the replacement runs current code", () => {
  // launchd has no by-label restart, so the domain-target kickstart -k form is
  // used: it kills the running instance and starts a fresh one in one call.
  // The user's uid scopes the gui domain target.
  expect(macosRestartCommands(501)).toEqual([
    ["launchctl", "kickstart", "-k", `gui/501/${MACOS_LABEL}`],
  ]);
});
