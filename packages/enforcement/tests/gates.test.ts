/**
 * The discipline gates, spawned end to end against a temp REGIMEN_DATA_DIR. Each
 * gate denies its target tool call (the deny shape Claude and Codex share) and
 * records a gate.denial across the store-write seam, with the harness label the
 * gate stamps. The shell gates record only when `jq` is on PATH; that branch is
 * skipped when jq is absent so the suite stays green on a bare host, but the
 * deny itself (exit 2) is always asserted.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RM_RF_CLAUDE = join(import.meta.dir, "..", "examples", "rm-rf-gate.ts");
const RM_RF_CODEX = join(
  import.meta.dir,
  "..",
  "examples",
  "rm-rf-gate-codex.ts",
);
const EM_DASH = join(import.meta.dir, "..", "examples", "em-dash-gate.sh");
const INLINE_MSG = join(
  import.meta.dir,
  "..",
  "examples",
  "inline-message-guard.sh",
);

const SESSION = "claude-test-gate-5b2c";
const hasJq = Bun.which("jq") !== null;

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

test("the rm-rf gate denies a recursive forced rm and records it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_rmrf",
      tool_input: { command: "rm -rf ./build" },
    };
    const proc = Bun.spawn(["bun", RM_RF_CLAUDE], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("gate.denial");
    expect(events[0]?.harness).toBe("claude");
    expect(events[0]?.attributes).toMatchObject({
      gate_id: "rm-rf-guard",
      tool_name: "Bash",
      tool_call_id: "toolu_rmrf",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rm-rf gate denies an uppercase -R recursive forced rm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_rmRf",
      tool_input: { command: "rm -Rf ./build" },
    };
    const proc = Bun.spawn(["bun", RM_RF_CLAUDE], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("gate.denial");
    expect(events[0]?.harness).toBe("claude");
    expect(events[0]?.attributes).toMatchObject({
      gate_id: "rm-rf-guard",
      tool_name: "Bash",
      tool_call_id: "toolu_rmRf",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Codex rm-rf gate denies an uppercase -R recursive forced rm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "019e8c20-codex",
      cwd: "/home/mlo/work",
      tool_name: "Bash",
      tool_use_id: "call_rmRf",
      tool_input: { command: "rm -Rf ./build" },
    };
    const proc = Bun.spawn(["bun", RM_RF_CODEX], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.harness).toBe("codex");
    expect(events[0]?.attributes).toMatchObject({
      gate_id: "rm-rf-guard",
      tool_call_id: "call_rmRf",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rm-rf gate allows a benign command and records nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_ls",
      tool_input: { command: "ls -la" },
    };
    const proc = Bun.spawn(["bun", RM_RF_CLAUDE], {
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

test("the Codex rm-rf gate stamps harness codex on the recorded denial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "019e8c20-codex",
      cwd: "/home/mlo/work",
      tool_name: "Bash",
      tool_use_id: "call_rmrf",
      tool_input: { command: "rm -rf ./build" },
    };
    const proc = Bun.spawn(["bun", RM_RF_CODEX], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain('"permissionDecision":"deny"');

    const events = readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]?.harness).toBe("codex");
    expect(events[0]?.attributes).toMatchObject({
      gate_id: "rm-rf-guard",
      tool_call_id: "call_rmrf",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rm-rf gate fails safe on malformed stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-gate-"));
  try {
    const proc = Bun.spawn(["bun", RM_RF_CLAUDE], {
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

test("the em-dash gate denies an em-dash edit (and records it as codex when jq is present)", async () => {
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

    if (hasJq) {
      const events = readEvents(dir);
      expect(events).toHaveLength(1);
      expect(events[0]?.harness).toBe("codex");
      expect(events[0]?.attributes).toMatchObject({
        gate_id: "em-dash-guard",
        tool_name: "Edit",
        tool_call_id: "toolu_emdash",
      });
    }
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

test("the inline-message gate denies a heredoc git commit (and records it when jq is present)", async () => {
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

    if (hasJq) {
      const events = readEvents(dir);
      expect(events).toHaveLength(1);
      expect(events[0]?.harness).toBe("codex");
      expect(events[0]?.attributes).toMatchObject({
        gate_id: "inline-message-guard",
        tool_name: "Bash",
        tool_call_id: "toolu_heredoc",
      });
    }
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
