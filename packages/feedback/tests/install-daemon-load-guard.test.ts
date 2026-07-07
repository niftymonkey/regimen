/**
 * The idempotent daemon-load orchestration. A fake command runner stands in for
 * launchctl so the macOS-specific already-loaded behavior is exercised without
 * touching the host supervisor. The guard keeps `regimen update` from erroring
 * with "Load failed: 5: Input/output error" when it re-runs the install over a
 * service that is already registered in the user's gui domain.
 */
import { expect, test } from "bun:test";
import {
  runDaemonInstallCommands,
  type CommandRunner,
} from "../src/cli/index.ts";

const LOAD_GUARD = [
  "launchctl",
  "print",
  "gui/501/dev.niftymonkey.regimen-feedback",
];
const INSTALL = [
  ["launchctl", "load", "-w", "/Users/test/Library/LaunchAgents/x.plist"],
];

function recordingRunner(exitFor: (cmd: ReadonlyArray<string>) => number): {
  run: CommandRunner;
  calls: ReadonlyArray<string>[];
} {
  const calls: ReadonlyArray<string>[] = [];
  const run: CommandRunner = (cmd) => {
    calls.push(cmd);
    return exitFor(cmd);
  };
  return { run, calls };
}

test("an already-registered service skips the load and leaves the running service in place", () => {
  const { run, calls } = recordingRunner((cmd) => (cmd[1] === "print" ? 0 : 1));
  const code = runDaemonInstallCommands(
    { installCommands: INSTALL, loadGuardCommand: LOAD_GUARD },
    run,
  );
  expect(code).toBe(0);
  expect(calls).toEqual([LOAD_GUARD]);
});

test("a not-yet-loaded service runs the load commands", () => {
  const { run, calls } = recordingRunner((cmd) => (cmd[1] === "print" ? 1 : 0));
  const code = runDaemonInstallCommands(
    { installCommands: INSTALL, loadGuardCommand: LOAD_GUARD },
    run,
  );
  expect(code).toBe(0);
  expect(calls).toEqual([LOAD_GUARD, INSTALL[0]!]);
});

test("a genuine load failure on a not-loaded service surfaces loudly", () => {
  const { run, calls } = recordingRunner(() => 5);
  const code = runDaemonInstallCommands(
    { installCommands: INSTALL, loadGuardCommand: LOAD_GUARD },
    run,
  );
  expect(code).toBe(5);
  expect(calls).toEqual([LOAD_GUARD, INSTALL[0]!]);
});

test("a plan without a load guard runs the install commands directly", () => {
  const { run, calls } = recordingRunner(() => 0);
  const code = runDaemonInstallCommands({ installCommands: INSTALL }, run);
  expect(code).toBe(0);
  expect(calls).toEqual([INSTALL[0]!]);
});
