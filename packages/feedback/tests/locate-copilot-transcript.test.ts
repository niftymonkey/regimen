/**
 * locateCopilotTranscript behavior. The locator maps a session id to its
 * transcript file path `<sessionsDir>/<session-id>/events.jsonl`, a fully
 * deterministic join (no scan), and confirms the file exists. A session id with
 * no matching file is the missing-transcript signal (null).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateCopilotTranscript } from "../src/copilot/locate-transcript.ts";

const SESSION_A = "e2ba254f-5455-47e2-aa80-1bc2706d7294";
const SESSION_B = "0cf23524-7925-4b53-8695-abfe23164ff0";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-copilot-locate-"));
  const sessionsDir = join(home, "session-state");
  try {
    fn(sessionsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTranscript(sessionsDir: string, sessionId: string): string {
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, "");
  return path;
}

test("a session id maps to its deterministic events.jsonl path under the session dir", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(sessionsDir, SESSION_B);
    const expected = writeTranscript(sessionsDir, SESSION_A);
    expect(locateCopilotTranscript(sessionsDir, SESSION_A)).toBe(expected);
  });
});

test("a session id with no transcript returns null (the missing-transcript signal)", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(sessionsDir, SESSION_B);
    expect(locateCopilotTranscript(sessionsDir, SESSION_A)).toBeNull();
  });
});

test("an absent session-state directory returns null rather than throwing", () => {
  withSessionsDir((sessionsDir) => {
    // sessionsDir was never created.
    expect(locateCopilotTranscript(sessionsDir, SESSION_A)).toBeNull();
  });
});
