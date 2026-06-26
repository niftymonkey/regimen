/**
 * The discipline gates, spawned end to end against a temp REGIMEN_DATA_DIR. Each
 * gate denies its target tool call (the deny shape Claude and Codex share) and
 * writes nothing to the buffer: a gate denies, it does not self-report the
 * denial. The deny itself (the deny decision on stdout, or exit 2 with the
 * reason on stderr for the shell gates) is always asserted.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RM_RF = join(import.meta.dir, "..", "examples", "rm-rf-gate.ts");
const EM_DASH = join(import.meta.dir, "..", "examples", "em-dash-gate.sh");
const INLINE_MSG = join(
  import.meta.dir,
  "..",
  "examples",
  "inline-message-guard.sh",
);

const SESSION = "claude-test-gate-5b2c";

/** The em dash (U+2014), built from its code point so this file holds none. */
const EM_DASH_CHAR = String.fromCharCode(0x2014);

/** Parse the buffer's current segment into objects, in order. */
function readEvents(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, "buffer", "current.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line));
}

test("the rm-rf gate blocks a recursive forced rm and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_rmrf",
      tool_input: { command: "rm -rf ./build" },
    };
    const proc = Bun.spawn(["bun", RM_RF], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir, REGIMEN_HARNESS: "codex" },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rm-rf gate blocks an uppercase -R recursive forced rm and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_rmRf",
      tool_input: { command: "rm -Rf ./build" },
    };
    const proc = Bun.spawn(["bun", RM_RF], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir, REGIMEN_HARNESS: "codex" },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rm-rf gate allows a benign command and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_ls",
      tool_input: { command: "ls -la" },
    };
    const proc = Bun.spawn(["bun", RM_RF], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rm-rf gate fails safe on malformed stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const proc = Bun.spawn(["bun", RM_RF], {
      stdin: new TextEncoder().encode("not valid json"),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the em-dash gate denies an em-dash edit and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      session_id: SESSION,
      tool_name: "Edit",
      tool_use_id: "toolu_emdash",
      tool_input: { new_string: `a long pause ${EM_DASH_CHAR} then more` },
    };
    const proc = Bun.spawn(["bash", EM_DASH], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir, REGIMEN_HARNESS: "codex" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("Blocked");
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the em-dash gate allows content with no em dash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      session_id: SESSION,
      tool_name: "Edit",
      tool_use_id: "toolu_clean",
      tool_input: { new_string: "a long pause, then more" },
    };
    const proc = Bun.spawn(["bash", EM_DASH], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inline-message gate denies a heredoc git commit and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_heredoc",
      tool_input: {
        command: "git commit -F - <<EOF\nmy subject\n\nbody\nEOF",
      },
    };
    const proc = Bun.spawn(["bash", INLINE_MSG], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir, REGIMEN_HARNESS: "codex" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("BLOCKED");
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inline-message gate allows a -m git commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_dashm",
      tool_input: { command: 'git commit -m "single line subject"' },
    };
    const proc = Bun.spawn(["bash", INLINE_MSG], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
