/**
 * locateRolloutFile behavior (S3). The locator maps a session id to its rollout
 * file path by the trailing UUID in the file name, without opening the file
 * (mirroring resolve-session.ts). A session id with no matching file is the
 * missing-transcript signal (null).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateRolloutFile } from "../src/codex/locate-rollout.ts";

const UUID_A = "019e8c20-4491-7ea3-b809-d6586a5a72b8";
const UUID_B = "019e8c15-9f76-7ed0-8f78-6137aead220e";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-locate-"));
  const sessionsDir = join(home, "sessions");
  try {
    fn(sessionsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeRollout(
  sessionsDir: string,
  isoStamp: string,
  uuid: string,
): string {
  const dir = join(sessionsDir, "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${isoStamp}-${uuid}.jsonl`);
  writeFileSync(path, "");
  return path;
}

test("a session id maps to its rollout file by the trailing UUID", () => {
  withSessionsDir((sessionsDir) => {
    writeRollout(sessionsDir, "2026-06-15T00-04-48", UUID_B);
    const expected = writeRollout(sessionsDir, "2026-06-15T00-16-25", UUID_A);
    expect(locateRolloutFile(sessionsDir, UUID_A)).toBe(expected);
  });
});

test("a session id with no rollout file returns null (the missing-transcript signal)", () => {
  withSessionsDir((sessionsDir) => {
    writeRollout(sessionsDir, "2026-06-15T00-04-48", UUID_B);
    expect(locateRolloutFile(sessionsDir, UUID_A)).toBeNull();
  });
});

test("an absent sessions directory returns null rather than throwing", () => {
  withSessionsDir((sessionsDir) => {
    // sessionsDir was never created.
    expect(locateRolloutFile(sessionsDir, UUID_A)).toBeNull();
  });
});
