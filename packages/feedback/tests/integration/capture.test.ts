import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnabled } from "../../src/enabled-flag.ts";
import { openStore } from "../../src/store.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "capture.ts");

const claudePreToolUse = {
  hook_event_name: "PreToolUse",
  session_id: "claude-test-7f3a",
  tool_name: "Edit",
  tool_use_id: "toolu_abc123",
  tool_input: {},
};

const claudeSessionStart = {
  hook_event_name: "SessionStart",
  session_id: "claude-test-7f3a",
  cwd: "/repo",
  source: "startup",
};

/** Seed the store with `n` unassessed conversations so the banner has a backlog. */
function seedBacklog(dataDir: string, n: number): void {
  const store = openStore(join(dataDir, "feedback.db"));
  for (let i = 0; i < n; i++) {
    store.db
      .prepare(
        `INSERT INTO conversations
           (session_id, harness, model, first_event_at, last_event_at)
         VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
      )
      .run(`sess-${i}`, "2026-07-04T08:00:00.000Z", "2026-07-04T08:30:00.000Z");
  }
  store.close();
}

async function runHook(
  payload: unknown,
  dataDir: string,
): Promise<{
  exit: number;
  stdout: string;
}> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
    stdout: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { exit: await proc.exited, stdout };
}

function withDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-capture-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the hook does not append while Feedback is off (no enabled flag, no buffer file)", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runHook(claudePreToolUse, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(join(dataDir, "buffer", "current.jsonl"))).toBe(false);
  });
});

test("the hook appends one envelope line to <bufferDir>/current.jsonl", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const { exit, stdout } = await runHook(claudePreToolUse, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");

    const currentPath = join(dataDir, "buffer", "current.jsonl");
    const lines = readFileSync(currentPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const envelope = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(envelope.harness).toBe("claude");
    expect(envelope.payload).toEqual(claudePreToolUse);
    expect(typeof envelope.captured_at).toBe("string");
  });
});

test("the hook envelopes payloads with no v1 mapping (the loader decides what to skip)", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const notification = {
      hook_event_name: "Notification",
      session_id: "claude-test-7f3a",
    };
    const { exit, stdout } = await runHook(notification, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");

    const currentPath = join(dataDir, "buffer", "current.jsonl");
    const envelope = JSON.parse(
      readFileSync(currentPath, "utf8").trim(),
    ) as Record<string, unknown>;
    expect(envelope.payload).toEqual(notification);
  });
});

test("on SessionStart the hook emits the backlog banner to stdout for context injection", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    seedBacklog(dataDir, 3);
    const { exit, stdout } = await runHook(claudeSessionStart, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toContain("3 conversations awaiting assessment");
  });
});

test("the banner is a SessionStart-only surface: other events stay stdout-silent", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    seedBacklog(dataDir, 3);
    const { exit, stdout } = await runHook(claudePreToolUse, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });
});

test("with no backlog, SessionStart stays stdout-silent", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    seedBacklog(dataDir, 0);
    const { exit, stdout } = await runHook(claudeSessionStart, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });
});

test("the hook exits 0 with no stdout when stdin is empty", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode(""),
      env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
  });
});

test("the hook records an error and exits 0 when stdin is not JSON", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode("not-json{"),
      env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");

    const errorLog = readFileSync(join(dataDir, "capture-errors.log"), "utf8");
    expect(errorLog).toContain("SyntaxError");
  });
});
