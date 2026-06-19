/**
 * The `feedback assess` CLI command (S3 spec section 6). Each test spawns the
 * CLI as a subprocess so argv parsing, env handling, exit codes, and stdout are
 * exercised the way an engineer's shell would. The full-pass test points the
 * adapter at a LOCAL mock Anthropic server via ANTHROPIC_BASE_URL, so the judge
 * round-trip is real wire shape but makes ZERO network calls off the machine.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI with explicit env overrides and an optional working dir. Keys
 * listed in `unset` are removed from the inherited environment, so a test can
 * exercise the missing-ANTHROPIC_API_KEY path even when the developer's shell
 * has the key set.
 */
async function runCliWith(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  cwd?: string,
  unset: ReadonlyArray<string> = [],
): Promise<CliResult> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of unset) delete merged[key];
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: merged,
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exit: await proc.exited, stdout, stderr };
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
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-assess-cli-"));
  const codexHome = mkdtempSync(join(tmpdir(), "regimen-assess-home-"));
  return fn({ dataDir, codexHome }).finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
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
      undefined,
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
