/**
 * The nightly-assessment trigger (ADR-0018).
 *
 * The feature is off unless `~/.config/regimen/env` turns it on, it never
 * judges inline, and it fires at most once a day on a catch-up rule rather
 * than at an appointed instant, so a laptop that slept through the night still
 * sweeps when it next wakes.
 */
import { expect, test } from "bun:test";
import { readNightlySettings } from "../src/judged/nightly.ts";

test("the nightly sweep is off when nothing is configured", () => {
  expect(readNightlySettings({})).toEqual({
    enabled: false,
    limit: 50,
    hour: 3,
  });
});

test("configuration turns the sweep on and sets its nightly cap", () => {
  expect(
    readNightlySettings({
      REGIMEN_AUTO_ASSESS: "1",
      REGIMEN_AUTO_ASSESS_LIMIT: "25",
      REGIMEN_AUTO_ASSESS_HOUR: "5",
    }),
  ).toEqual({ enabled: true, limit: 25, hour: 5 });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maybeTriggerNightlySweep,
  nightlySweepCommand,
} from "../src/judged/nightly.ts";

const ON = { REGIMEN_AUTO_ASSESS: "1", REGIMEN_AUTO_ASSESS_HOUR: "3" };

/** A local-time instant, so the test does not depend on the machine's zone. */
function localTime(
  year: number,
  month: number,
  day: number,
  hour: number,
): () => number {
  const at = new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
  return () => at;
}

function withDataDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-nightly-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a sweep that has never run launches once the hour has come", () => {
  withDataDir((dir) => {
    const launched: number[] = [];
    const fired = maybeTriggerNightlySweep({
      dataDir: dir,
      env: { ...ON, REGIMEN_AUTO_ASSESS_LIMIT: "25" },
      now: localTime(2026, 8, 20, 4),
      launch: (settings) => launched.push(settings.limit),
    });

    expect(fired).toBe(true);
    expect(launched).toEqual([25]);
    expect(
      readFileSync(join(dir, "auto-assess-last-swept"), "utf8").trim(),
    ).toBe("2026-08-20");
  });
});

test("a sweep does not launch while the feature is off", () => {
  withDataDir((dir) => {
    const launched: number[] = [];
    const fired = maybeTriggerNightlySweep({
      dataDir: dir,
      env: {},
      now: localTime(2026, 8, 20, 4),
      launch: (settings) => launched.push(settings.limit),
    });

    expect(fired).toBe(false);
    expect(launched).toEqual([]);
  });
});

test("a sweep does not launch twice in one day", () => {
  withDataDir((dir) => {
    writeFileSync(join(dir, "auto-assess-last-swept"), "2026-08-20\n");
    const launched: number[] = [];
    const fired = maybeTriggerNightlySweep({
      dataDir: dir,
      env: ON,
      now: localTime(2026, 8, 20, 23),
      launch: (settings) => launched.push(settings.limit),
    });

    expect(fired).toBe(false);
    expect(launched).toEqual([]);
  });
});

test("a machine that slept through the hour still sweeps when it wakes", () => {
  withDataDir((dir) => {
    writeFileSync(join(dir, "auto-assess-last-swept"), "2026-08-19\n");
    const launched: number[] = [];
    const fired = maybeTriggerNightlySweep({
      dataDir: dir,
      env: ON,
      now: localTime(2026, 8, 20, 11),
      launch: (settings) => launched.push(settings.limit),
    });

    expect(fired).toBe(true);
    expect(launched).toEqual([50]);
  });
});

test("a sweep waits for the configured hour", () => {
  withDataDir((dir) => {
    const launched: number[] = [];
    const fired = maybeTriggerNightlySweep({
      dataDir: dir,
      env: ON,
      now: localTime(2026, 8, 20, 1),
      launch: (settings) => launched.push(settings.limit),
    });

    expect(fired).toBe(false);
    expect(launched).toEqual([]);
  });
});

test("the launched sweep is a separate regimen process, never an inline judge", () => {
  expect(nightlySweepCommand({})).toEqual([
    "regimen",
    "assess",
    "--all",
    "--auto",
  ]);
});

test("the launcher honors a configured regimen binary", () => {
  expect(
    nightlySweepCommand({ REGIMEN_AUTO_ASSESS_COMMAND: "/opt/bin/regimen" }),
  ).toEqual(["/opt/bin/regimen", "assess", "--all", "--auto"]);
});
