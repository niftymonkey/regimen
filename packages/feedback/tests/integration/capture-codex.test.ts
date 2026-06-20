import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionStamp } from "../../src/codex/session-stamp.ts";
import { setEnabled } from "../../src/enabled-flag.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "capture-codex.ts");

const codexSessionStart = {
  hook_event_name: "SessionStart",
  session_id: "codex-test-9a2b",
  cwd: "/repo",
  model: "gpt-5.5",
  permission_mode: "auto",
  source: "startup",
};

async function runHook(
  payload: unknown,
  dataDir: string,
): Promise<{ exit: number; stdout: string }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
    stdout: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { exit: await proc.exited, stdout };
}

function withDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-capture-codex-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the hook records an error and exits 0 when stdin is not JSON (a capture failure never surfaces)", async () => {
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

test("the hook does not append while Feedback is off (no enabled flag, no buffer file)", async () => {
  await withDataDir(async (dataDir) => {
    const { exit, stdout } = await runHook(codexSessionStart, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(join(dataDir, "buffer", "current.jsonl"))).toBe(false);
  });
});

test("the hook appends one envelope line stamped with the codex harness", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const { exit, stdout } = await runHook(codexSessionStart, dataDir);
    expect(exit).toBe(0);
    expect(stdout).toBe("");

    const currentPath = join(dataDir, "buffer", "current.jsonl");
    const lines = readFileSync(currentPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const envelope = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(envelope.harness).toBe("codex");
    expect(envelope.payload).toEqual(codexSessionStart);
    expect(typeof envelope.captured_at).toBe("string");
  });
});

test("a SessionStart also stamps the session id for its cwd", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    await runHook(codexSessionStart, dataDir);
    expect(readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" })).toBe(
      "codex-test-9a2b",
    );
  });
});

test("a non-SessionStart event writes no stamp", async () => {
  await withDataDir(async (dataDir) => {
    setEnabled(dataDir);
    const preToolUse = {
      hook_event_name: "PreToolUse",
      session_id: "codex-test-9a2b",
      cwd: "/repo",
      tool_name: "Bash",
      tool_use_id: "call_1",
    };
    await runHook(preToolUse, dataDir);
    expect(
      readSessionStamp({ dataDir, harness: "codex", cwd: "/repo" }),
    ).toBeNull();
  });
});
