/**
 * locateClaudeTranscript behavior. The locator maps a session id to its
 * transcript file path under `<projectsDir>/<cwd-slug>/<session-id>.jsonl`,
 * matching the base name `<sessionId>.jsonl` without opening the file. A session
 * id with no matching file is the missing-transcript signal (null).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateClaudeTranscript } from "../src/claude/locate-transcript.ts";

const SESSION_A = "08551ace-1f3c-40b2-a088-ef00ce37027f";
const SESSION_B = "0830e0a9-3c4a-44c9-ad56-e9849fe728c9";

function withProjectsDir(fn: (projectsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-claude-locate-"));
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
): string {
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, "");
  return path;
}

test("a session id maps to its transcript file by the base name under its project slug", () => {
  withProjectsDir((projectsDir) => {
    writeTranscript(projectsDir, "-home-eng-other", SESSION_B);
    const expected = writeTranscript(
      projectsDir,
      "-home-eng-project",
      SESSION_A,
    );
    expect(locateClaudeTranscript(projectsDir, SESSION_A)).toBe(expected);
  });
});

test("a session id with no transcript returns null (the missing-transcript signal)", () => {
  withProjectsDir((projectsDir) => {
    writeTranscript(projectsDir, "-home-eng-other", SESSION_B);
    expect(locateClaudeTranscript(projectsDir, SESSION_A)).toBeNull();
  });
});

test("an absent projects directory returns null rather than throwing", () => {
  withProjectsDir((projectsDir) => {
    // projectsDir was never created.
    expect(locateClaudeTranscript(projectsDir, SESSION_A)).toBeNull();
  });
});
