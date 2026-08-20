/**
 * The nightly-assessment trigger (ADR-0018).
 *
 * The capture daemon decides that a sweep is due and launches a separate
 * process to run it; it never judges inline, because a metered, minutes-long
 * call to an external provider must not sit inside the loop that drains the
 * capture buffer. The rule is a catch-up one, "has a sweep run today", so a
 * laptop asleep at any appointed hour sweeps when it next wakes instead of
 * silently skipping the night.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where the daemon records the date of the last sweep it launched. */
const LAST_SWEPT_FILE = "auto-assess-last-swept";

/** The nightly cap when the config names none: an unusual day with room over. */
const DEFAULT_LIMIT = 50;

/** The earliest local hour a sweep may start when the config names none. */
const DEFAULT_HOUR = 3;

/** Values that read as "on" in the config file, case-insensitively. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Parse a bounded positive integer from a config value, falling back to
 * `fallback` for anything absent, unparseable, or out of range. A config file
 * must never break the daemon, so a bad value degrades to the default rather
 * than throwing.
 */
function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

/** What `~/.config/regimen/env` says about the nightly sweep. */
export interface NightlySettings {
  readonly enabled: boolean;
  readonly limit: number;
  readonly hour: number;
}

/**
 * Read the nightly-sweep settings from an environment (the daemon loads
 * `~/.config/regimen/env` onto it first). Off unless explicitly turned on.
 */
export function readNightlySettings(env: NodeJS.ProcessEnv): NightlySettings {
  const flag = env.REGIMEN_AUTO_ASSESS?.trim().toLowerCase() ?? "";
  return {
    enabled: TRUTHY.has(flag),
    limit: boundedInt(env.REGIMEN_AUTO_ASSESS_LIMIT, DEFAULT_LIMIT, 1, 10_000),
    hour: boundedInt(env.REGIMEN_AUTO_ASSESS_HOUR, DEFAULT_HOUR, 0, 23),
  };
}

/** Inputs to {@link maybeTriggerNightlySweep}; clock and launcher are injected. */
export interface TriggerOptions {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly launch: (settings: NightlySettings) => void;
}

/**
 * Launch tonight's sweep if one is due, and record that it ran. Returns
 * whether it launched.
 *
 * The date is recorded before the launch, not after, so a sweep that dies on
 * its way up costs the night rather than relaunching on every tick until
 * midnight. A missing or unreadable marker reads as "never swept".
 */
export function maybeTriggerNightlySweep(options: TriggerOptions): boolean {
  const settings = readNightlySettings(options.env);
  if (!settings.enabled) return false;
  const at = new Date(options.now());
  if (at.getHours() < settings.hour) return false;
  const today = localDate(at);
  if (readLastSwept(options.dataDir) === today) return false;
  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(join(options.dataDir, LAST_SWEPT_FILE), `${today}\n`);
  options.launch(settings);
  return true;
}

/** The local calendar date of `at`, as `YYYY-MM-DD`. */
function localDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/** The date of the last sweep this daemon launched, or null if there is none. */
function readLastSwept(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, LAST_SWEPT_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * The command the daemon launches for tonight's sweep: the ordinary `regimen`
 * CLI in its nightly mode, run as its own process so a judge call that hangs,
 * fails, or is killed never reaches the capture loop. `REGIMEN_AUTO_ASSESS_COMMAND`
 * names the binary when it is not on the daemon's PATH.
 */
export function nightlySweepCommand(env: NodeJS.ProcessEnv): string[] {
  const bin = env.REGIMEN_AUTO_ASSESS_COMMAND?.trim();
  return [
    bin === undefined || bin === "" ? "regimen" : bin,
    "assess",
    "--all",
    "--auto",
  ];
}
