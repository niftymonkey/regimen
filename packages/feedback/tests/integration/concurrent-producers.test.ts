/**
 * Concurrent-producer stress: ~100 hook subprocesses across 4 fake sessions
 * fired in parallel against the same buffer dir. Proves the regular-file
 * O_APPEND assumption on Linux/macOS (FILE_APPEND_DATA on native Windows)
 * holds: each call's envelope lands as exactly one line, no clobbering and
 * no torn lines, regardless of the order the kernel commits them.
 *
 * Failure mode: a torn line in `current.jsonl` would show up as one extra
 * quarantine row after the drain. The test asserts zero quarantine and
 * `events_inserted === total_hook_calls`.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainBuffer } from "../../src/loader/drain.ts";
import { setEnabled } from "../../src/enabled-flag.ts";
import { openStore } from "../../src/store.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "capture.ts");

const SESSIONS = [
  "concurrent-s0",
  "concurrent-s1",
  "concurrent-s2",
  "concurrent-s3",
] as const;
const CALLS_PER_SESSION = 25;
const TOTAL_CALLS = SESSIONS.length * CALLS_PER_SESSION;

async function fireHook(payload: unknown, dataDir: string): Promise<number> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
    stdout: "pipe",
  });
  return proc.exited;
}

test("100 concurrent hook subprocesses across 4 sessions produce no torn lines and no clobbering", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-concurrent-"));
  setEnabled(dataDir);
  try {
    const calls: Array<Promise<number>> = [];
    for (const session of SESSIONS) {
      for (let i = 0; i < CALLS_PER_SESSION; i++) {
        calls.push(
          fireHook(
            {
              hook_event_name: "PreToolUse",
              session_id: session,
              tool_name: "Edit",
              tool_use_id: `toolu_${session}_${i}`,
              tool_input: {},
            },
            dataDir,
          ),
        );
      }
    }
    const exits = await Promise.all(calls);
    for (const code of exits) expect(code).toBe(0);

    const bufferDir = join(dataDir, "buffer");
    const raw = readFileSync(join(bufferDir, "current.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(TOTAL_CALLS);
    for (const line of lines) {
      // A torn line throws here; a clean append parses.
      const env = JSON.parse(line) as Record<string, unknown>;
      expect(env.harness).toBe("claude");
    }

    const store = openStore(join(dataDir, "feedback.db"));
    try {
      const result = drainBuffer(bufferDir, store);
      expect(result.lines_read).toBe(TOTAL_CALLS);
      expect(result.events_inserted).toBe(TOTAL_CALLS);
      expect(result.quarantined).toBe(0);

      const perSession = store.db
        .prepare(
          "SELECT session_id, COUNT(*) AS n FROM events GROUP BY session_id ORDER BY session_id",
        )
        .all() as ReadonlyArray<{ session_id: string; n: number }>;
      expect(perSession.length).toBe(SESSIONS.length);
      for (const row of perSession) {
        expect(row.n).toBe(CALLS_PER_SESSION);
        expect(SESSIONS).toContain(row.session_id as (typeof SESSIONS)[number]);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);
