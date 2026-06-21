/**
 * The Copilot harness support bundle, exercised through the registry seam. These
 * are the registration tests: harnessSupport("copilot") returns the descriptor
 * plus the Copilot reader/resolver pair, locate marks the newest transcript open
 * and an older one complete, and the descriptor carries Copilot's contract row
 * (COPILOT_HOME / hooks/hooks.json / session-state) so the generic judge path
 * never names the harness.
 */
import { afterEach, expect, test } from "bun:test";
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
import { COPILOT_SESSION_ID_ENV } from "../src/copilot/resolve-session.ts";

const SESSION_OLD = "0cf23524-7925-4b53-8695-abfe23164ff0";
const SESSION_NEW = "e2ba254f-5455-47e2-aa80-1bc2706d7294";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-copilot-support-"));
  const sessionsDir = join(home, "session-state");
  try {
    fn(sessionsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  mtimeSec: number,
): void {
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
}

const priorSessionEnv = process.env[COPILOT_SESSION_ID_ENV];
afterEach(() => {
  if (priorSessionEnv === undefined) delete process.env[COPILOT_SESSION_ID_ENV];
  else process.env[COPILOT_SESSION_ID_ENV] = priorSessionEnv;
});

test("the copilot descriptor carries the Copilot contract row", () => {
  const support = harnessSupport("copilot");
  expect(support).toBeDefined();
  const contract = support!.descriptor.contract;
  expect(contract.harness).toBe("copilot");
  expect(contract.configHome.envVar).toBe("COPILOT_HOME");
  expect(contract.configHome.defaultSubdir).toBe(".copilot");
  expect(contract.hooksFile.relativePath).toBe("hooks/hooks.json");
  expect(contract.skillsSubdir).toBe("skills");
  expect(support!.descriptor.transcriptsSubdir).toBe("session-state");
});

test("the copilot resolver reads the current session id from the shell env", () => {
  process.env[COPILOT_SESSION_ID_ENV] = SESSION_NEW;
  const support = harnessSupport("copilot");
  expect(
    support!.resolver.resolveCurrent({
      dataDir: "/unused",
      harnessHome: "/unused",
      cwd: "/unused",
    }),
  ).toBe(SESSION_NEW);
});

test("the copilot resolver marks the newest transcript open and an older one complete", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(sessionsDir, SESSION_OLD, 1000);
    writeTranscript(sessionsDir, SESSION_NEW, 2000);
    const support = harnessSupport("copilot");
    expect(support).toBeDefined();

    const newest = support!.resolver.locate({
      sessionsDir,
      sessionId: SESSION_NEW,
    });
    expect(newest?.open).toBe(true);
    expect(newest?.path.endsWith(join(SESSION_NEW, "events.jsonl"))).toBe(true);

    const older = support!.resolver.locate({
      sessionsDir,
      sessionId: SESSION_OLD,
    });
    expect(older?.open).toBe(false);
    expect(older?.path.endsWith(join(SESSION_OLD, "events.jsonl"))).toBe(true);
  });
});

test("the copilot resolver returns null for a session with no transcript", () => {
  withSessionsDir((sessionsDir) => {
    const support = harnessSupport("copilot");
    expect(
      support!.resolver.locate({
        sessionsDir,
        sessionId: "no-such-session",
      }),
    ).toBeNull();
  });
});
