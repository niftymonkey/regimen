/**
 * The CLI's PROCESS boundary: output completeness when stdout is a pipe.
 *
 * Every other CLI suite drives commands in-process and captures output by
 * swapping `process.stdout.write`, so no test ever creates a real pipe or
 * reaches the entrypoint's exit. That blind spot is exactly where a large
 * result set was being truncated at the 64 KB pipe buffer. This suite spawns
 * the real CLI as a subprocess so the pipe and the exit both happen.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openStore } from "../../feedback/src/store.ts";

const CLI_ENTRY = join(dirname(import.meta.dir), "src", "cli", "index.ts");
const PIPE_BUFFER_BYTES = 65_536;
const SESSIONS = 400;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedStore(sessionCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-process-output-"));
  tempDirs.push(dir);
  const store = openStore(join(dir, "feedback.db"));
  const db = store.db;
  for (let i = 0; i < sessionCount; i += 1) {
    const sessionId = `session-${String(i).padStart(4, "0")}-aaaabbbbccccdddd`;
    const at = `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`;
    db.prepare(
      `INSERT INTO conversations
         (session_id, harness, model, first_event_at, last_event_at)
       VALUES (?, 'claude', 'claude-opus-5', ?, ?)`,
    ).run(sessionId, at, at);
  }
  store.close();
  return dir;
}

async function runCliProcess(
  args: ReadonlyArray<string>,
  dataDir: string,
): Promise<{ exit: number; stdout: string }> {
  // Through a real shell pipe, not Bun's own stdout pipe: only an OS pipe
  // reproduces the 64 KB buffer the entrypoint used to abandon on exit.
  const piped = [`bun ${CLI_ENTRY} ${args.join(" ")} | cat`];
  const proc = Bun.spawn(["sh", "-c", ...piped], {
    env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { exit, stdout };
}

test("list --json into a pipe returns every session, past the pipe buffer", async () => {
  const dataDir = seedStore(SESSIONS);

  const { exit, stdout } = await runCliProcess(["list", "--json"], dataDir);

  expect(exit).toBe(0);
  expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
  const sessions = JSON.parse(stdout) as ReadonlyArray<{ sessionId: string }>;
  expect(sessions).toHaveLength(SESSIONS);
});
