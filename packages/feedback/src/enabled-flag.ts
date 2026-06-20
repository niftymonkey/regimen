/**
 * The enabled flag: a single file at a fixed path that gates both the
 * capture hook and the loader daemon per ADR-0006. Treating capture and
 * storage as one gate is what makes the privacy guarantee real: when
 * Feedback is off, the hook appends nothing and the daemon stops, so a
 * sensitive conversation is never captured in the first place.
 *
 * `feedback start` creates the flag; `feedback stop` removes it. The hook
 * stats it on every event; the daemon checks it on a short cadence and
 * self-exits if removed. The file's content is not load-bearing; presence
 * is the entire signal.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FLAG_NAME = "feedback.enabled";

export function enabledFlagPath(dataDir: string): string {
  return join(dataDir, FLAG_NAME);
}

export function isEnabled(dataDir: string): boolean {
  return existsSync(enabledFlagPath(dataDir));
}

export function setEnabled(dataDir: string): void {
  const path = enabledFlagPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

export function clearEnabled(dataDir: string): void {
  try {
    rmSync(enabledFlagPath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
