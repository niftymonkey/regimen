/**
 * newestCopilotTranscript behavior. Copilot keeps each session in its own
 * directory `<sessionsDir>/<id>/events.jsonl`; the session id (a UUID) does not
 * sort chronologically, so the newest (live) transcript is the events.jsonl with
 * the greatest mtime. The path it returns is what the resolver compares against
 * to set a located session's `open` flag.
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
import { newestCopilotTranscript } from "../src/copilot/newest-transcript.ts";

const SESSION_A = "e2ba254f-5455-47e2-aa80-1bc2706d7294";
const SESSION_B = "0cf23524-7925-4b53-8695-abfe23164ff0";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-copilot-newest-"));
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
): string {
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

test("the events.jsonl with the greatest mtime is the newest, regardless of UUID ordering", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(sessionsDir, SESSION_A, 1000);
    const newest = writeTranscript(sessionsDir, SESSION_B, 2000);
    expect(newestCopilotTranscript(sessionsDir)).toBe(newest);
  });
});

test("an empty or absent session-state tree returns null", () => {
  withSessionsDir((sessionsDir) => {
    expect(newestCopilotTranscript(sessionsDir)).toBeNull();
  });
});
