/**
 * The Gemini harness support bundle, exercised through the registry seam. These
 * are the registration tests: harnessSupport("gemini") returns the descriptor
 * plus the Gemini reader/resolver pair, resolveCurrent reads the live session id
 * from the filesystem (the Codex pattern, no env var), locate marks the newest
 * transcript open and an older one complete, and the descriptor carries Gemini's
 * contract row (GEMINI_CONFIG_DIR / settings.json / tmp) so the generic judge
 * path never names the harness.
 */
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

const SESSION_OLD = "aaaaaaaa-482c-4b2d-bbfb-c9ba0982f534";
const SESSION_NEW = "bbddfdf7-482c-4b2d-bbfb-c9ba0982f534";

function withHome(
  fn: (harnessHome: string, sessionsDir: string) => void,
): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-gemini-support-"));
  const sessionsDir = join(home, "tmp");
  try {
    fn(home, sessionsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTranscript(
  sessionsDir: string,
  alias: string,
  fileName: string,
  sessionId: string,
  mtimeSec: number,
): void {
  const dir = join(sessionsDir, alias, "chats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(
    path,
    `${JSON.stringify({ sessionId, startTime: "2026-06-19T06:08:26.036Z", kind: "main" })}\n`,
  );
  utimesSync(path, mtimeSec, mtimeSec);
}

test("the gemini descriptor carries the Gemini contract row", () => {
  const support = harnessSupport("gemini");
  expect(support).toBeDefined();
  const contract = support!.descriptor.contract;
  expect(contract.harness).toBe("gemini");
  expect(contract.configHome.envVar).toBe("GEMINI_CONFIG_DIR");
  expect(contract.configHome.defaultSubdir).toBe(".gemini");
  expect(contract.hooksFile.relativePath).toBe("settings.json");
  expect(contract.hooksFile.format).toBe("nested-matcher-groups");
  expect(contract.skillsSubdir).toBe("skills");
  expect(support!.descriptor.transcriptsSubdir).toBe("tmp");
});

test("the gemini resolver resolves the current session by filesystem (no env var)", () => {
  withHome((harnessHome, sessionsDir) => {
    writeTranscript(sessionsDir, "dev", "session-new.jsonl", SESSION_NEW, 2000);
    const support = harnessSupport("gemini");
    expect(
      support!.resolver.resolveCurrent({
        dataDir: "/unused",
        harnessHome,
        cwd: "/home/eng/dev",
      }),
    ).toBe(SESSION_NEW);
  });
});

test("the gemini resolver marks the newest transcript open and an older one complete", () => {
  withHome((_harnessHome, sessionsDir) => {
    writeTranscript(sessionsDir, "dev", "session-old.jsonl", SESSION_OLD, 1000);
    writeTranscript(
      sessionsDir,
      "regimen",
      "session-new.jsonl",
      SESSION_NEW,
      2000,
    );
    const support = harnessSupport("gemini");
    expect(support).toBeDefined();

    const newest = support!.resolver.locate({
      sessionsDir,
      sessionId: SESSION_NEW,
    });
    expect(newest?.open).toBe(true);
    expect(newest?.path.endsWith("session-new.jsonl")).toBe(true);

    const older = support!.resolver.locate({
      sessionsDir,
      sessionId: SESSION_OLD,
    });
    expect(older?.open).toBe(false);
    expect(older?.path.endsWith("session-old.jsonl")).toBe(true);
  });
});

test("the gemini resolver returns null for a session with no transcript", () => {
  withHome((_harnessHome, sessionsDir) => {
    const support = harnessSupport("gemini");
    expect(
      support!.resolver.locate({
        sessionsDir,
        sessionId: "no-such-session",
      }),
    ).toBeNull();
  });
});
