/**
 * The supervised-start liveness wait: poll a liveness probe until the daemon
 * is observably live or a timeout elapses, with an injected clock so the
 * polling is deterministic and free of real time.
 */
import { expect, test } from "bun:test";
import { waitForDaemonAlive } from "../src/cli/wait-for-daemon.ts";

test("returns true immediately when the daemon is already live", () => {
  const result = waitForDaemonAlive(() => true, {
    timeoutMs: 1000,
    pollMs: 10,
    now: () => 0,
    sleep: () => {},
  });
  expect(result).toBe(true);
});

test("polls, sleeping between probes, until the daemon reports live", () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = waitForDaemonAlive(
    () => {
      calls += 1;
      return calls >= 3;
    },
    {
      timeoutMs: 1000,
      pollMs: 10,
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
      },
    },
  );
  expect(result).toBe(true);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([10, 10]);
});

test("returns false when the daemon never becomes live within the timeout", () => {
  let clock = 0;
  let calls = 0;
  const result = waitForDaemonAlive(
    () => {
      calls += 1;
      return false;
    },
    {
      timeoutMs: 50,
      pollMs: 10,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
      },
    },
  );
  expect(result).toBe(false);
  // timeoutMs/pollMs = 50/10, so the probe runs about six times before the
  // deadline; assert it kept polling to the timeout rather than bailing early.
  expect(calls).toBeGreaterThanOrEqual(5);
});
