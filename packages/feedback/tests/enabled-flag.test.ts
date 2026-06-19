/**
 * The enabled-flag gate: a single file at a fixed path under the data
 * directory. Capture and the daemon both gate on it so "Feedback off"
 * means nothing was captured, not "captured but hidden."
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEnabled,
  enabledFlagPath,
  isEnabled,
  setEnabled,
} from "../src/enabled-flag.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-flag-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("enabledFlagPath resolves to feedback.enabled under the data dir", () => {
  expect(enabledFlagPath("/some/data/dir")).toBe(
    "/some/data/dir/feedback.enabled",
  );
});

test("isEnabled returns false when the flag file has never been created", () => {
  withTempDir((dir) => {
    expect(isEnabled(dir)).toBe(false);
  });
});

test("setEnabled creates the flag file and isEnabled then returns true", () => {
  withTempDir((dir) => {
    setEnabled(dir);
    expect(existsSync(enabledFlagPath(dir))).toBe(true);
    expect(isEnabled(dir)).toBe(true);
  });
});

test("setEnabled creates the data directory if it does not yet exist", () => {
  withTempDir((dir) => {
    const nested = join(dir, "not-yet-created");
    setEnabled(nested);
    expect(isEnabled(nested)).toBe(true);
  });
});

test("clearEnabled removes the flag and is idempotent when it is already absent", () => {
  withTempDir((dir) => {
    setEnabled(dir);
    expect(isEnabled(dir)).toBe(true);
    clearEnabled(dir);
    expect(isEnabled(dir)).toBe(false);
    clearEnabled(dir);
    expect(isEnabled(dir)).toBe(false);
  });
});
