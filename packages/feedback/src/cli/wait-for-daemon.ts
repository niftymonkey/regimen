/**
 * Wait until the daemon is observably live, or give up after a timeout.
 *
 * A supervisor command (systemctl/launchctl/schtasks) returns as soon as it
 * has handed the process to the service manager, which for a `Type=simple`
 * unit is the instant the loader is exec'd, before the loader has initialized
 * and written its pid file. A lifecycle command must not report success on
 * that bare hand-off: a loader that execs and then crashes on startup would
 * make the supervisor return 0 while no daemon is live, and `feedback status`
 * would briefly report "not running" right after a "success". So after a
 * supervised start or restart the CLI polls for observable liveness and only
 * then reports success, failing loudly on timeout.
 *
 * Pure and clock-injectable: `isAlive` is the liveness probe, and `now` and
 * `sleep` default to the wall clock and `Bun.sleepSync` but are injected in
 * tests so the polling logic is deterministic without real time.
 */
export interface WaitForDaemonOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
}

export function waitForDaemonAlive(
  isAlive: () => boolean,
  options: WaitForDaemonOptions,
): boolean {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const deadline = now() + options.timeoutMs;
  for (;;) {
    if (isAlive()) return true;
    if (now() >= deadline) return false;
    sleep(options.pollMs);
  }
}
