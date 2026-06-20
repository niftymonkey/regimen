import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnabled } from "../../src/enabled-flag.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "capture.ts");

const claudePreToolUse = {
  hook_event_name: "PreToolUse",
  session_id: "claude-test-7f3a",
  tool_name: "Edit",
  tool_use_id: "toolu_abc123",
  tool_input: {},
};

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
