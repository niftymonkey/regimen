/**
 * newestClaudeTranscript behavior. Claude transcript files are named by session
 * UUID, which does not sort chronologically, so the newest (live) transcript is
 * the one with the greatest mtime. The path it returns is what the resolver
 * compares against to set a located session's `open` flag.
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
import { newestClaudeTranscript } from "../src/claude/newest-transcript.ts";

const SESSION_A = "08551ace-1f3c-40b2-a088-ef00ce37027f";
const SESSION_B = "0830e0a9-3c4a-44c9-ad56-e9849fe728c9";

function withProjectsDir(fn: (projectsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-claude-newest-"));
  const projectsDir = join(home, "projects");
  try {
    fn(projectsDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeTranscript(
  projectsDir: string,
  slug: string,
  sessionId: string,
  mtimeSec: number,
): string {
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

test("the transcript with the greatest mtime is the newest, regardless of UUID ordering", () => {
  withProjectsDir((projectsDir) => {
    writeTranscript(projectsDir, "-home-eng-a", SESSION_A, 1000);
    const newest = writeTranscript(projectsDir, "-home-eng-b", SESSION_B, 2000);
    expect(newestClaudeTranscript(projectsDir)).toBe(newest);
  });
});

test("an empty or absent projects tree returns null", () => {
  withProjectsDir((projectsDir) => {
    expect(newestClaudeTranscript(projectsDir)).toBeNull();
  });
});
