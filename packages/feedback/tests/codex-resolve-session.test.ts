import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCodexHome,
  resolveCurrentSession,
} from "../src/codex/resolve-session.ts";
import { writeSessionStamp } from "../src/codex/session-stamp.ts";

/** A temp data dir and codex home, cleaned up after `fn`. */
function withDirs(fn: (dataDir: string, codexHome: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-resolve-data-"));
  const codexHome = mkdtempSync(join(tmpdir(), "regimen-resolve-codex-"));
  try {
    fn(dataDir, codexHome);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

/**
 * Write an empty rollout file for `sessionId` under the codex home's sessions
 * tree, with its mtime set to `mtimeSec` so recency is deterministic.
 */
function writeRollout(
  codexHome: string,
  isoStamp: string,
  sessionId: string,
  mtimeSec: number,
): void {
  const dir = join(codexHome, "sessions", "2026", "06", "03");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${isoStamp}-${sessionId}.jsonl`);
  writeFileSync(path, "");
  utimesSync(path, mtimeSec, mtimeSec);
}

const UUID_A = "019e8c20-4491-7ea3-b809-d6586a5a72b8";
const UUID_B = "019e8c15-9f76-7ed0-8f78-6137aead220e";

test("a stamped session for the cwd is resolved", () => {
  withDirs((dataDir, codexHome) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "stamped-1",
    });
    expect(resolveCurrentSession({ dataDir, codexHome, cwd: "/repo" })).toBe(
      "stamped-1",
    );
  });
});

test("with no stamp, the newest rollout by mtime resolves to its filename UUID", () => {
  withDirs((dataDir, codexHome) => {
    writeRollout(codexHome, "2026-06-03T00-04-48", UUID_B, 1000);
    writeRollout(codexHome, "2026-06-03T00-16-25", UUID_A, 2000);
    expect(resolveCurrentSession({ dataDir, codexHome, cwd: "/repo" })).toBe(
      UUID_A,
    );
  });
});

test("the stamp wins even when a newer rollout exists for another cwd", () => {
  withDirs((dataDir, codexHome) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "stamped-1",
    });
    writeRollout(codexHome, "2026-06-03T00-16-25", UUID_A, 9000);
    expect(resolveCurrentSession({ dataDir, codexHome, cwd: "/repo" })).toBe(
      "stamped-1",
    );
  });
});

test("no stamp and no rollouts resolves to null", () => {
  withDirs((dataDir, codexHome) => {
    expect(
      resolveCurrentSession({ dataDir, codexHome, cwd: "/repo" }),
    ).toBeNull();
  });
});

test("a rollout that vanishes mid-scan is skipped, not thrown", () => {
  withDirs((dataDir, codexHome) => {
    writeRollout(codexHome, "2026-06-03T00-04-48", UUID_B, 1000);
    // A dangling symlink named like a newer rollout: it appears in readdir but
    // statSync (which follows the link) throws, mimicking a file rotated away
    // between the directory scan and the stat.
    const dir = join(codexHome, "sessions", "2026", "06", "03");
    symlinkSync(
      join(dir, "gone.jsonl"),
      join(dir, `rollout-2026-06-03T00-16-25-${UUID_A}.jsonl`),
    );
    expect(resolveCurrentSession({ dataDir, codexHome, cwd: "/repo" })).toBe(
      UUID_B,
    );
  });
});

test("resolveCodexHome honours CODEX_HOME, else defaults to ~/.codex", () => {
  expect(resolveCodexHome({ CODEX_HOME: "/custom/codex" }, "/home/me")).toBe(
    "/custom/codex",
  );
  expect(resolveCodexHome({}, "/home/me")).toBe("/home/me/.codex");
});
