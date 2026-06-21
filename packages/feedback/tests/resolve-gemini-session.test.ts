/**
 * resolveGeminiSession behavior. Gemini exposes no session-id env var to the
 * agent's shell, so resolution is filesystem-based (the Codex pattern): the
 * project alias is the basename of the cwd, the session lives under
 * `<harnessHome>/tmp/<alias>/chats/`, and the resolver reads the newest
 * transcript's line-0 init `sessionId`. No stamp file is written or read. Absent
 * any transcript it returns null (the fail-closed "no current session" signal).
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
import { resolveGeminiSession } from "../src/gemini/resolve-session.ts";

const SESSION_OLD = "aaaaaaaa-482c-4b2d-bbfb-c9ba0982f534";
const SESSION_NEW = "bbddfdf7-482c-4b2d-bbfb-c9ba0982f534";

function withHome(fn: (harnessHome: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-gemini-resolve-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTranscript(
  harnessHome: string,
  alias: string,
  fileName: string,
  sessionId: string,
  mtimeSec: number,
): void {
  const dir = join(harnessHome, "tmp", alias, "chats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(
    path,
    `${JSON.stringify({ sessionId, startTime: "2026-06-19T06:08:26.036Z", kind: "main" })}\n`,
  );
  utimesSync(path, mtimeSec, mtimeSec);
}

test("the current session id is the newest transcript's init id under the cwd-aliased chats dir", () => {
  withHome((harnessHome) => {
    writeTranscript(harnessHome, "dev", "session-old.jsonl", SESSION_OLD, 1000);
    writeTranscript(harnessHome, "dev", "session-new.jsonl", SESSION_NEW, 2000);
    expect(
      resolveGeminiSession({
        dataDir: "/unused",
        harnessHome,
        cwd: "/home/eng/dev",
      }),
    ).toBe(SESSION_NEW);
  });
});

test("a cwd whose alias has no chats directory resolves to null", () => {
  withHome((harnessHome) => {
    writeTranscript(harnessHome, "dev", "session-new.jsonl", SESSION_NEW, 2000);
    expect(
      resolveGeminiSession({
        dataDir: "/unused",
        harnessHome,
        cwd: "/home/eng/other-project",
      }),
    ).toBeNull();
  });
});
