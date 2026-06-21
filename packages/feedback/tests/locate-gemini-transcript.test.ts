/**
 * locateGeminiTranscript behavior. Gemini exposes no session id to the shell, so
 * the locator maps a full session id to its transcript file by recursively
 * scanning `<sessionsDir>/<alias>/chats/session-*.jsonl` and matching each
 * candidate's line-0 init `sessionId` (the filename's hex8 is only a prefix). A
 * session id with no matching file is the missing-transcript signal (null).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateGeminiTranscript } from "../src/gemini/locate-transcript.ts";

const SESSION_A = "bbddfdf7-482c-4b2d-bbfb-c9ba0982f534";
const SESSION_B = "cefab7cd-2b43-40ab-abee-600bae8b48d7";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-gemini-locate-"));
  const sessionsDir = join(home, "tmp");
  try {
    fn(sessionsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Write a transcript under an alias whose init line stamps the full session id. */
function writeTranscript(
  sessionsDir: string,
  alias: string,
  fileName: string,
  sessionId: string,
): string {
  const dir = join(sessionsDir, alias, "chats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(
    path,
    `${JSON.stringify({ sessionId, startTime: "2026-06-19T06:08:26.036Z", kind: "main" })}\n`,
  );
  return path;
}

test("a full session id is matched by reading each candidate's init line, not its filename hex8", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(
      sessionsDir,
      "dev",
      "session-2026-06-18T04-39-cefab7cd.jsonl",
      SESSION_B,
    );
    // The hex8 in this filename does NOT match SESSION_A's prefix, proving the
    // match is by the init-line sessionId, not the filename.
    const expected = writeTranscript(
      sessionsDir,
      "dev",
      "session-2026-06-19T06-08-zzzzzzzz.jsonl",
      SESSION_A,
    );
    expect(locateGeminiTranscript(sessionsDir, SESSION_A)).toBe(expected);
  });
});

test("a session id with no transcript returns null (the missing-transcript signal)", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(
      sessionsDir,
      "dev",
      "session-2026-06-18T04-39-cefab7cd.jsonl",
      SESSION_B,
    );
    expect(locateGeminiTranscript(sessionsDir, SESSION_A)).toBeNull();
  });
});

test("an absent sessions tree returns null rather than throwing", () => {
  withSessionsDir((sessionsDir) => {
    expect(locateGeminiTranscript(sessionsDir, SESSION_A)).toBeNull();
  });
});
