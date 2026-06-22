/**
 * The `feedback assess` CLI command (S3 spec section 6), driven IN-PROCESS
 * through the exported `assess` facade (ADR-0012) rather than by spawning a `bun`
 * subprocess per assertion. The env handling, exit codes, and stdout/stderr are
 * exercised the way an engineer's shell would, without paying a bun cold-start
 * per test. The full-pass test points the adapter at a LOCAL mock Anthropic
 * server via ANTHROPIC_BASE_URL, so the judge round-trip is real wire shape but
 * makes ZERO network calls off the machine.
 *
 * Why in-process: each `Bun.spawn(["bun", CLI, ...])` paid a cold-start that
 * historically raced this suite's per-test timeout under load. Calling the facade
 * directly removes the flake. Each test runs inside an isolated env (temp
 * REGIMEN_DATA_DIR, temp CODEX_HOME, pinned ANTHROPIC_*) with stdout/stderr
 * captured by patching the write streams; `afterEach` restores both the env and
 * the streams so the in-process driving leaves no global state behind.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchFeedback } from "./facade-dispatch.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

/**
 * The per-harness marker env vars the resolver falls back to when REGIMEN_HARNESS
 * is unset; cleared in beforeEach so the suite is independent of whichever
 * harness CLI happens to be running it.
 */
const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];

/** The env keys this suite pins or clears, captured and restored per test. */
const MANAGED_ENV = [
  ...HARNESS_MARKERS,
  "CODEX_HOME",
  "REGIMEN_DATA_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  for (const marker of HARNESS_MARKERS) delete process.env[marker];
  savedStdoutWrite = process.stdout.write.bind(process.stdout);
  savedStderrWrite = process.stderr.write.bind(process.stderr);
});

afterEach(() => {
  process.stdout.write = savedStdoutWrite;
  process.stderr.write = savedStderrWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Pin explicit env overrides for one call (keys listed in `unset` are removed
 * from process.env so a test can exercise the missing-ANTHROPIC_API_KEY path
 * even when the developer's shell has the key set), then drive the facade
 * dispatch in-process and capture stdout/stderr. The assess facade is async, so
 * the result is awaited.
 */
async function runCliWith(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  unset: ReadonlyArray<string> = [],
): Promise<CliResult> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  for (const key of unset) delete process.env[key];

  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  const exit = await dispatchFeedback(args);
  return { exit, stdout, stderr };
}

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real Codex rollout: meta, a human prompt, an assistant answer. */
const TRANSCRIPT = [
  line({
    timestamp: "2026-06-15T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: SESSION,
      cwd: "/work/p",
      originator: "codex_exec",
      source: "exec",
    },
  }),
  line({
    timestamp: "2026-06-15T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "add a test for the parser" }],
    },
  }),
  line({
    timestamp: "2026-06-15T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done, the parser test passes." }],
    },
  }),
].join("\n");

/**
 * Seed the transcript as the only rollout under CODEX_HOME/sessions, and compute
 * the chunk ids the verdict must cite (lineSeq 0 and 1 for the prompt/answer).
 */
function seedRollout(codexHome: string): void {
  const dir = join(codexHome, "sessions", "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-15T10-00-00-${SESSION}.jsonl`),
    TRANSCRIPT,
  );
}

/**
 * A local HTTP server that answers /v1/messages with a canned verdict citing
 * chunk ids 0 and 1, the way the real judge would. Returns its base URL and a
 * stop() to close it. Nothing leaves the machine.
 */
function startMockAnthropic(): { baseUrl: string; stop: () => void } {
  const verdict = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [0, 1],
    },
    outcome: { value: "accomplished-cleanly", anchors: [1] },
  });
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: verdict }],
        stop_reason: "end_turn",
      });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

function withTemp(
  fn: (paths: { dataDir: string; codexHome: string }) => Promise<void>,
): Promise<void> {
  return fn({
    dataDir: tempDir("regimen-assess-cli-"),
    codexHome: tempDir("regimen-assess-home-"),
  });
}

test("feedback assess with no --session resolves the current session for the env-detected harness", async () => {
  await withTemp(async ({ dataDir, codexHome }) => {
    // No rollout seeded and no stamp, so the codex resolver finds nothing and the
    // command fails closed with the resolve error rather than a flag-usage error.
    const { exit, stderr } = await runCliWith(["assess"], {
      REGIMEN_DATA_DIR: dataDir,
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(1);
    expect(stderr).toContain("could not resolve the current codex session id");
  });
});

test("feedback assess --session runs the full pass against a mock judge and prints the digest", async () => {
  await withTemp(async ({ dataDir, codexHome }) => {
    seedRollout(codexHome);
    const mock = startMockAnthropic();
    try {
      const { exit, stdout } = await runCliWith(
        ["assess", "--session", SESSION],
        {
          REGIMEN_DATA_DIR: dataDir,
          REGIMEN_HARNESS: "codex",
          CODEX_HOME: codexHome,
          ANTHROPIC_API_KEY: "sk-ant-test",
          ANTHROPIC_BASE_URL: mock.baseUrl,
        },
      );
      expect(exit).toBe(0);
      const digest = JSON.parse(stdout);
      expect(digest.judged).toBe(true);
      expect(digest.sessionId).toBe(SESSION);
      expect(digest.complete).toBe(true);
      expect(digest.outcome.value).toBe("accomplished-cleanly");
      // The headline assessment resolved an inserted-event anchor.
      expect(digest.assessment.anchors.length).toBeGreaterThan(0);
    } finally {
      mock.stop();
    }
  });
});

test("feedback assess --session with no ANTHROPIC_API_KEY exits 1 with a clear error", async () => {
  await withTemp(async ({ dataDir, codexHome }) => {
    // The transcript exists, so the only failure is the missing key: resolving
    // the judge model now throws inside the try, yielding a clean stderr message
    // and exit 1 rather than an unhandled rejection.
    seedRollout(codexHome);
    const { exit, stderr } = await runCliWith(
      ["assess", "--session", SESSION],
      {
        REGIMEN_DATA_DIR: dataDir,
        REGIMEN_HARNESS: "codex",
        CODEX_HOME: codexHome,
      },
      ["ANTHROPIC_API_KEY"],
    );
    expect(exit).toBe(1);
    expect(stderr).toContain("ANTHROPIC_API_KEY");
    // The clean path writes only the message line: no unhandled-rejection stack
    // trace and no runtime banner, which is the difference between the catch and
    // a throw escaping before the try.
    expect(stderr).not.toContain("    at ");
    expect(stderr).not.toContain("Bun v");
  });
});

test("feedback assess --session with a missing transcript exits nonzero with a clear error", async () => {
  await withTemp(async ({ dataDir, codexHome }) => {
    // No rollout seeded under CODEX_HOME/sessions: the locator finds nothing.
    const { exit, stderr } = await runCliWith(
      ["assess", "--session", SESSION],
      {
        REGIMEN_DATA_DIR: dataDir,
        REGIMEN_HARNESS: "codex",
        CODEX_HOME: codexHome,
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    );
    expect(exit).not.toBe(0);
    expect(stderr).toContain(SESSION);
  });
});
