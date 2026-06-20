/**
 * The Claude harness support bundle, exercised through the registry seam. These
 * are the registration tests: harnessSupport("claude") returns the descriptor
 * plus the Claude reader/resolver pair, locate marks the newest transcript open
 * and an older one complete, and the descriptor carries Claude's contract row
 * (CLAUDE_CONFIG_DIR / settings.json / projects) so the generic judge path never
 * names the harness.
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
import { CLAUDE_SESSION_ID_ENV } from "../src/claude/resolve-session.ts";

const SESSION_OLD = "0830e0a9-3c4a-44c9-ad56-e9849fe728c9";
const SESSION_NEW = "08551ace-1f3c-40b2-a088-ef00ce37027f";

function withProjectsDir(fn: (projectsDir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "regimen-claude-support-"));
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
): void {
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
}

const priorSessionEnv = process.env[CLAUDE_SESSION_ID_ENV];
afterEach(() => {
  if (priorSessionEnv === undefined) delete process.env[CLAUDE_SESSION_ID_ENV];
  else process.env[CLAUDE_SESSION_ID_ENV] = priorSessionEnv;
});

test("the claude descriptor carries the Claude contract row", () => {
  const support = harnessSupport("claude");
  expect(support).toBeDefined();
  const contract = support!.descriptor.contract;
  expect(contract.harness).toBe("claude");
  expect(contract.configHome.envVar).toBe("CLAUDE_CONFIG_DIR");
  expect(contract.configHome.defaultSubdir).toBe(".claude");
  expect(contract.hooksFile.relativePath).toBe("settings.json");
  expect(contract.skillsSubdir).toBe("skills");
  expect(support!.descriptor.transcriptsSubdir).toBe("projects");
});

test("the claude resolver reads the current session id from the shell env", () => {
  process.env[CLAUDE_SESSION_ID_ENV] = SESSION_NEW;
  const support = harnessSupport("claude");
  expect(
    support!.resolver.resolveCurrent({
      dataDir: "/unused",
      harnessHome: "/unused",
      cwd: "/unused",
    }),
  ).toBe(SESSION_NEW);
});

test("the claude resolver marks the newest transcript open and an older one complete", () => {
  withProjectsDir((projectsDir) => {
    writeTranscript(projectsDir, "-home-eng-a", SESSION_OLD, 1000);
    writeTranscript(projectsDir, "-home-eng-b", SESSION_NEW, 2000);
    const support = harnessSupport("claude");
    expect(support).toBeDefined();

    const newest = support!.resolver.locate({
      sessionsDir: projectsDir,
      sessionId: SESSION_NEW,
    });
    expect(newest?.open).toBe(true);
    expect(newest?.path.endsWith(`${SESSION_NEW}.jsonl`)).toBe(true);

    const older = support!.resolver.locate({
      sessionsDir: projectsDir,
      sessionId: SESSION_OLD,
    });
    expect(older?.open).toBe(false);
    expect(older?.path.endsWith(`${SESSION_OLD}.jsonl`)).toBe(true);
  });
});

test("the claude resolver returns null for a session with no transcript", () => {
  withProjectsDir((projectsDir) => {
    const support = harnessSupport("claude");
    expect(
      support!.resolver.locate({
        sessionsDir: projectsDir,
        sessionId: "no-such-session",
      }),
    ).toBeNull();
  });
});
