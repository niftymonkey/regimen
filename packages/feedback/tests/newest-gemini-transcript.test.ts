/**
 * newestGeminiTranscript behavior. Gemini keeps each session in
 * `<sessionsDir>/<alias>/chats/session-*.jsonl`; the filename embeds an ISO
 * start, but mtime is the safe key for last activity, so the newest (live)
 * transcript is the session-*.jsonl with the greatest mtime. The path it returns
 * is what the resolver compares against to set a located session's `open` flag.
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
import { newestGeminiTranscript } from "../src/gemini/newest-transcript.ts";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-gemini-newest-"));
  const sessionsDir = join(home, "tmp");
  try {
    fn(sessionsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTranscript(
  sessionsDir: string,
  alias: string,
  fileName: string,
  mtimeSec: number,
): string {
  const dir = join(sessionsDir, alias, "chats");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

test("the session-*.jsonl with the greatest mtime is the newest, across aliases", () => {
  withSessionsDir((sessionsDir) => {
    writeTranscript(
      sessionsDir,
      "dev",
      "session-2026-06-18T04-39-aaaa.jsonl",
      1000,
    );
    const newest = writeTranscript(
      sessionsDir,
      "regimen",
      "session-2026-06-19T06-08-bbbb.jsonl",
      2000,
    );
    expect(newestGeminiTranscript(sessionsDir)).toBe(newest);
  });
});

test("an empty or absent sessions tree returns null", () => {
  withSessionsDir((sessionsDir) => {
    expect(newestGeminiTranscript(sessionsDir)).toBeNull();
  });
});
