import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionStamp,
  writeSessionStamp,
} from "../src/codex/session-stamp.ts";

function withDataDir(fn: (dataDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-codex-stamp-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a stamped session id reads back for the same cwd", () => {
  withDataDir((dataDir) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "sess-abc",
    });
    expect(readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" })).toBe(
      "sess-abc",
    );
  });
});

test("an unstamped cwd reads back as null", () => {
  withDataDir((dataDir) => {
    expect(
      readSessionStamp({ dataDir, harness: "codex", cwd: "/never-stamped" }),
    ).toBeNull();
  });
});

test("a corrupt stamp file reads back as null rather than throwing", () => {
  withDataDir((dataDir) => {
    const stampDir = join(dataDir, "codex", "sessions");
    mkdirSync(stampDir, { recursive: true });
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "sess-abc",
    });
    const [name] = readdirSync(stampDir);
    writeFileSync(join(stampDir, name ?? ""), "{not json");
    expect(
      readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" }),
    ).toBeNull();
  });
});

test("a valid stamp JSON with no sessionId reads back as null", () => {
  withDataDir((dataDir) => {
    const stampDir = join(dataDir, "codex", "sessions");
    mkdirSync(stampDir, { recursive: true });
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "sess-abc",
    });
    const [name] = readdirSync(stampDir);
    writeFileSync(join(stampDir, name ?? ""), JSON.stringify({ cwd: "/repo" }));
    expect(
      readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" }),
    ).toBeNull();
  });
});

test("a re-stamp of the same cwd wins (last SessionStart wins)", () => {
  withDataDir((dataDir) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "first",
    });
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "second",
    });
    expect(readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" })).toBe(
      "second",
    );
  });
});

test("distinct cwds keep distinct stamps", () => {
  withDataDir((dataDir) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo-a",
      sessionId: "sess-a",
    });
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo-b",
      sessionId: "sess-b",
    });
    expect(
      readSessionStamp({ dataDir, harness: "codex", cwd: "/repo-a" }),
    ).toBe("sess-a");
    expect(
      readSessionStamp({ dataDir, harness: "codex", cwd: "/repo-b" }),
    ).toBe("sess-b");
  });
});

test("the same cwd under distinct harnesses round-trips independently", () => {
  withDataDir((dataDir) => {
    writeSessionStamp({
      dataDir,
      harness: "codex",
      cwd: "/repo",
      sessionId: "codex-sess",
    });
    writeSessionStamp({
      dataDir,
      harness: "claude",
      cwd: "/repo",
      sessionId: "claude-sess",
    });
    expect(readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" })).toBe(
      "codex-sess",
    );
    expect(readSessionStamp({ dataDir, harness: "claude", cwd: "/repo" })).toBe(
      "claude-sess",
    );
  });
});
