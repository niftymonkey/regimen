/**
 * #17 acceptance tests: end-to-end against the real producer.
 *
 * Spawns `src/loader/run.ts` against a temp REGIMEN_DATA_DIR, fires the real
 * `hooks/capture.ts` subprocess one or more times with Claude payloads, and
 * verifies the events table reflects them through the four AC bullets:
 *   (a) freshness within ~1 second of the hook returning;
 *   (b) one row per event with the required columns;
 *   (c) restart-idempotent (a second loader run sees zero new inserts);
 *   (d) hook footprint unchanged (one envelope line per hook call, the hook
 *       writes nothing else and does not touch the SQLite store directly).
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSealedSegment } from "../../hooks/event-log.ts";
import { clearEnabled, setEnabled } from "../../src/enabled-flag.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK = join(REPO_ROOT, "hooks", "capture.ts");
const LOADER = join(REPO_ROOT, "src", "loader", "run.ts");

/**
 * Per-test ceiling for the acceptance tests, well above bun's 5s default.
 *
 * Each test here spawns one or more cold `bun` subprocesses (the loader, the
 * capture hook, the CLI). Under contention (a concurrent agent session, or the
 * pre-commit hook running prettier and the full suite at once) a single cold
 * spawn can stretch past a second, so the 5s default can guillotine a test
 * that is progressing fine, not stuck. This ceiling sits above the in-test
 * hang detectors (startLoader's 30s deadline, the `waitFor` timeouts), so a
 * genuinely stuck loader still fails first, with a descriptive error, well
 * before this fires. It is a backstop, not a latency assertion.
 */
const ACCEPTANCE_TIMEOUT_MS = 45_000;

function acceptanceTest(name: string, fn: () => Promise<void>): void {
  test(name, fn, ACCEPTANCE_TIMEOUT_MS);
}

const sessionStart = (id: string) => ({
  hook_event_name: "SessionStart",
  session_id: id,
  source: "startup",
  model: "claude-opus-4-7",
});
const preToolUse = (id: string, callId: string) => ({
  hook_event_name: "PreToolUse",
  session_id: id,
  tool_name: "Edit",
  tool_use_id: callId,
  tool_input: {},
});
const postToolUse = (id: string, callId: string) => ({
  hook_event_name: "PostToolUse",
  session_id: id,
  tool_name: "Edit",
  tool_use_id: callId,
  tool_response: { success: true },
});

interface LoaderHandle {
  proc: ReturnType<typeof Bun.spawn>;
  stop(): Promise<void>;
}

async function startLoader(
  dataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<LoaderHandle> {
  const proc = Bun.spawn(["bun", LOADER], {
    env: { ...process.env, REGIMEN_DATA_DIR: dataDir, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // The deadline is a hang detector, not a performance assertion: a cold `bun`
  // loader spawn signals `ready` in roughly 300ms when uncontended, but each
  // run spawns ten of them and CPU contention from a concurrent agent session
  // can stretch a single spawn well past a second. A generous ceiling only
  // trips on a genuinely stuck loader; it does not assert startup latency.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    if (buf.includes("ready\n")) break;
  }
  reader.releaseLock();
  if (!buf.includes("ready\n")) {
    proc.kill();
    throw new Error(
      "loader did not signal ready before the hang-detector deadline",
    );
  }
  return {
    proc,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

async function runHook(payload: unknown, dataDir: string): Promise<void> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
    stdout: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`capture hook exited ${exit}`);
}

function countEvents(dataDir: string): number {
  const db = new Database(join(dataDir, "feedback.db"), { readonly: true });
  try {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

async function waitFor<T>(
  fn: () => T | null,
  timeoutMs: number,
): Promise<{ value: T; elapsedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value !== null) return { value, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

function withDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-acceptance-"));
  setEnabled(dir);
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

acceptanceTest(
  "AC (a) freshness: an event lands within ~1s of the hook returning",
  async () => {
    await withDataDir(async (dataDir) => {
      const loader = await startLoader(dataDir);
      try {
        const sessionId = "ac-freshness";
        await runHook(sessionStart(sessionId), dataDir);
        const t0 = Date.now();
        const { elapsedMs } = await waitFor(
          () => (countEvents(dataDir) >= 1 ? true : null),
          2000,
        );
        const ttDb = Date.now() - t0;
        expect(ttDb).toBeLessThan(1000);
        expect(elapsedMs).toBeLessThan(1000);
      } finally {
        await loader.stop();
      }
    });
  },
);

acceptanceTest(
  "AC (b) one row per event with the required columns",
  async () => {
    await withDataDir(async (dataDir) => {
      const loader = await startLoader(dataDir);
      try {
        const id = "ac-rows";
        await runHook(sessionStart(id), dataDir);
        await runHook(preToolUse(id, "toolu_1"), dataDir);
        await runHook(postToolUse(id, "toolu_1"), dataDir);
        await waitFor(() => (countEvents(dataDir) >= 3 ? true : null), 2000);

        const db = new Database(join(dataDir, "feedback.db"), {
          readonly: true,
        });
        try {
          const rows = db
            .prepare(
              "SELECT session_id, event_type, harness, model, span_phase, span_name, trace_id, timestamp FROM events ORDER BY timestamp, event_type",
            )
            .all() as ReadonlyArray<{
            session_id: string;
            event_type: string;
            harness: string;
            model: string | null;
            span_phase: string;
            span_name: string;
            trace_id: string;
            timestamp: string;
          }>;
          expect(rows.length).toBe(3);
          const types = new Set(rows.map((r) => r.event_type));
          expect(types).toEqual(
            new Set(["session.start", "tool.pre", "tool.post"]),
          );
          for (const row of rows) {
            expect(row.session_id).toBe(id);
            expect(row.harness).toBe("claude");
            expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
            expect(row.timestamp.length).toBeGreaterThan(0);
            expect(row.span_phase.length).toBeGreaterThan(0);
            expect(row.span_name.length).toBeGreaterThan(0);
          }
          const sessionStartRow = rows.find(
            (r) => r.event_type === "session.start",
          );
          expect(sessionStartRow?.model).toBe("claude-opus-4-7");
        } finally {
          db.close();
        }
      } finally {
        await loader.stop();
      }
    });
  },
);

acceptanceTest(
  "AC (c) restart-idempotent: a second loader run inserts zero new events",
  async () => {
    await withDataDir(async (dataDir) => {
      const first = await startLoader(dataDir);
      const id = "ac-restart";
      try {
        await runHook(sessionStart(id), dataDir);
        await runHook(preToolUse(id, "toolu_x"), dataDir);
        await waitFor(() => (countEvents(dataDir) >= 2 ? true : null), 2000);
      } finally {
        await first.stop();
      }
      expect(countEvents(dataDir)).toBe(2);

      const second = await startLoader(dataDir);
      try {
        await new Promise((r) => setTimeout(r, 200));
        expect(countEvents(dataDir)).toBe(2);
      } finally {
        await second.stop();
      }
    });
  },
);

acceptanceTest(
  "AC (d) hook footprint: one envelope per call, no other side effects",
  async () => {
    await withDataDir(async (dataDir) => {
      await runHook(sessionStart("ac-footprint"), dataDir);
      await runHook(preToolUse("ac-footprint", "toolu_y"), dataDir);

      const bufferDir = join(dataDir, "buffer");
      const bufferFiles = readdirSync(bufferDir);
      expect(bufferFiles).toEqual(["current.jsonl"]);

      const lines = readFileSync(join(bufferDir, "current.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const env = JSON.parse(line) as Record<string, unknown>;
        expect(env.harness).toBe("claude");
        expect(typeof env.captured_at).toBe("string");
        expect(typeof env.payload).toBe("object");
      }

      const topLevel = readdirSync(dataDir);
      expect(topLevel.sort()).toEqual(["buffer", "feedback.enabled"]);
      const bufferStat = statSync(join(bufferDir, "current.jsonl"));
      expect(bufferStat.size).toBeGreaterThan(0);
    });
  },
);

acceptanceTest(
  "the daemon rotates an oversized buffer when REGIMEN_ROTATE_MAX_BYTES is set",
  async () => {
    await withDataDir(async (dataDir) => {
      const bufferDir = join(dataDir, "buffer");
      for (let i = 0; i < 12; i++) {
        await runHook(sessionStart(`ac-rotate-${i}`), dataDir);
      }
      expect(statSync(join(bufferDir, "current.jsonl")).size).toBeGreaterThan(
        1024,
      );

      const loader = await startLoader(dataDir, {
        REGIMEN_ROTATE_MAX_BYTES: "1024",
      });
      try {
        await waitFor(
          () =>
            countEvents(dataDir) >= 12 &&
            !existsSync(join(bufferDir, "current.jsonl")) &&
            readdirSync(bufferDir).filter(isSealedSegment).length === 0
              ? true
              : null,
          10000,
        );
      } finally {
        await loader.stop();
      }

      expect(countEvents(dataDir)).toBe(12);
      expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(false);
      expect(readdirSync(bufferDir).filter(isSealedSegment).length).toBe(0);
    });
  },
);

acceptanceTest(
  "feedback status reports the daemon as running with its pid while the loader is alive",
  async () => {
    await withDataDir(async (dataDir) => {
      const loader = await startLoader(dataDir);
      try {
        const cli = join(REPO_ROOT, "src", "cli", "index.ts");
        const proc = Bun.spawn(["bun", cli, "status"], {
          env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(stdout).toContain("feedback: enabled");
        expect(stdout).toContain(`running (pid ${loader.proc.pid ?? -1})`);
      } finally {
        await loader.stop();
      }
    });
  },
);

acceptanceTest(
  "the daemon tails Codex rollouts into the store when REGIMEN_CODEX_SESSIONS_DIR is set",
  async () => {
    await withDataDir(async (dataDir) => {
      const sessionsDir = mkdtempSync(
        join(tmpdir(), "regimen-codex-sessions-"),
      );
      const rollout = [
        JSON.stringify({
          timestamp: "2026-06-04T00:00:00.100Z",
          type: "session_meta",
          payload: { id: "rollout-tail-sess", cwd: "/tmp/x" },
        }),
        // The canonical response_item user message is the user_prompt source;
        // the event_msg twin below is the dedup'd copy the fold ignores.
        JSON.stringify({
          timestamp: "2026-06-04T00:00:00.990Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-04T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "hi" },
        }),
      ].join("\n");
      writeFileSync(
        join(sessionsDir, "rollout-2026-06-04T00-00-00-000Z-aaaabbbb.jsonl"),
        rollout,
      );

      const codexSessionStarts = (): number => {
        const db = new Database(join(dataDir, "feedback.db"), {
          readonly: true,
        });
        try {
          return (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE harness = 'codex' AND session_id = ? AND event_type = 'session.start'",
              )
              .get("rollout-tail-sess") as { n: number }
          ).n;
        } finally {
          db.close();
        }
      };

      const loader = await startLoader(dataDir, {
        REGIMEN_CODEX_SESSIONS_DIR: sessionsDir,
        REGIMEN_ROLLOUT_POLL_MS: "150",
      });
      try {
        await waitFor(() => (codexSessionStarts() >= 1 ? true : null), 5000);

        const db = new Database(join(dataDir, "feedback.db"), {
          readonly: true,
        });
        try {
          const types = (
            db
              .prepare(
                "SELECT event_type FROM events WHERE harness = 'codex' AND session_id = ?",
              )
              .all("rollout-tail-sess") as ReadonlyArray<{
              event_type: string;
            }>
          ).map((r) => r.event_type);
          expect(types).toContain("session.start");
          expect(types).toContain("user_prompt");
        } finally {
          db.close();
        }
      } finally {
        await loader.stop();
        rmSync(sessionsDir, { recursive: true, force: true });
      }
    });
  },
);

acceptanceTest(
  "the daemon writes daemon.pid on startup and removes it on graceful shutdown",
  async () => {
    await withDataDir(async (dataDir) => {
      const loader = await startLoader(dataDir);
      const pidPath = join(dataDir, "daemon.pid");
      try {
        expect(existsSync(pidPath)).toBe(true);
        const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
        expect(pid).toBe(loader.proc.pid ?? -1);
      } finally {
        await loader.stop();
      }
      expect(existsSync(pidPath)).toBe(false);
    });
  },
);

acceptanceTest(
  "the daemon refuses to start when the enabled flag is absent",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "regimen-disabled-"));
    try {
      const proc = Bun.spawn(["bun", LOADER], {
        env: { ...process.env, REGIMEN_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      expect(exit).toBe(1);
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("feedback is not enabled");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

acceptanceTest(
  "the daemon writes a bounded operational log instead of a per-drain firehose",
  async () => {
    await withDataDir(async (dataDir) => {
      const loader = await startLoader(dataDir);
      try {
        for (let i = 0; i < 5; i += 1) {
          await runHook(sessionStart(`ac-oplog-${i}`), dataDir);
        }
        await waitFor(() => (countEvents(dataDir) >= 5 ? true : null), 3000);
      } finally {
        await loader.stop();
      }
      const logPath = join(dataDir, "daemon.log");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      const kinds = lines.map((line) => line.split(" ")[1] ?? "");
      // Lifecycle is recorded and routine drains are not: every line is a
      // lifecycle or heartbeat entry, never a per-drain firehose line.
      expect(kinds).toContain("started");
      expect(kinds).toContain("ready");
      expect(kinds.filter((kind) => kind === "heartbeat").length).toBe(1);
      for (const kind of kinds) {
        expect(["started", "ready", "shutdown", "heartbeat"]).toContain(kind);
      }
    });
  },
);

acceptanceTest(
  "the daemon exits cleanly within ~1s when the enabled flag is removed mid-run",
  async () => {
    await withDataDir(async (dataDir) => {
      const loader = await startLoader(dataDir, {
        REGIMEN_FLAG_POLL_MS: "100",
      });
      try {
        clearEnabled(dataDir);
        const exitedWithin = await Promise.race([
          loader.proc.exited.then((code) => ({ exited: true as const, code })),
          new Promise<{ exited: false }>((r) =>
            setTimeout(() => r({ exited: false }), 1500),
          ),
        ]);
        expect(exitedWithin.exited).toBe(true);
        if (exitedWithin.exited) {
          expect(exitedWithin.code).toBe(0);
        }
      } finally {
        if (!loader.proc.killed) await loader.stop();
      }
    });
  },
);
