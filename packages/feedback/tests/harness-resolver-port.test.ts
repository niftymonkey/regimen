import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessSupport } from "../src/harness/support.ts";
import { writeSessionStamp } from "../src/codex/session-stamp.ts";

function withDirs(fn: (dataDir: string, harnessHome: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-resolver-port-data-"));
  const harnessHome = mkdtempSync(
    join(tmpdir(), "regimen-resolver-port-home-"),
  );
  try {
    fn(dataDir, harnessHome);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(harnessHome, { recursive: true, force: true });
  }
}

/** Write an empty rollout for `sessionId` with a deterministic mtime. */
function writeRollout(
  harnessHome: string,
  isoStamp: string,
  sessionId: string,
  mtimeSec: number,
): void {
  const dir = join(harnessHome, "sessions", "2026", "06", "03");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${isoStamp}-${sessionId}.jsonl`);
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
}

const UUID_OLD = "019e8c15-9f76-7ed0-8f78-6137aead220e";
const UUID_NEW = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

test("resolver.resolveCurrent returns the stamped session for a cwd", () => {
  withDirs((dataDir, harnessHome) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "stamped-port",
    });
    const support = harnessSupport("codex");
    expect(support).toBeDefined();
    expect(
      support!.resolver.resolveCurrent({ dataDir, harnessHome, cwd: "/repo" }),
    ).toBe("stamped-port");
  });
});

test("resolver.locate marks the newest rollout open and an older one complete", () => {
  withDirs((_dataDir, harnessHome) => {
    writeRollout(harnessHome, "2026-06-03T00-04-48", UUID_OLD, 1000);
    writeRollout(harnessHome, "2026-06-03T00-16-25", UUID_NEW, 2000);
    const sessionsDir = join(harnessHome, "sessions");
    const support = harnessSupport("codex");
    expect(support).toBeDefined();

    const newest = support!.resolver.locate({
      sessionsDir,
      sessionId: UUID_NEW,
    });
    expect(newest?.open).toBe(true);
    expect(newest?.path.endsWith(`${UUID_NEW}.jsonl`)).toBe(true);

    const older = support!.resolver.locate({
      sessionsDir,
      sessionId: UUID_OLD,
    });
    expect(older?.open).toBe(false);
    expect(older?.path.endsWith(`${UUID_OLD}.jsonl`)).toBe(true);
  });
});

test("resolver.locate returns null for a session with no rollout file", () => {
  withDirs((_dataDir, harnessHome) => {
    const sessionsDir = join(harnessHome, "sessions");
    const support = harnessSupport("codex");
    expect(
      support!.resolver.locate({ sessionsDir, sessionId: "no-such-session" }),
    ).toBeNull();
  });
});
