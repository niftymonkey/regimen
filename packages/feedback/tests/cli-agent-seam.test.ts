/**
 * The tier C agent-driven judging seam, driven IN-PROCESS through the exported
 * `emitPrompt` and `recordVerdict` facades (ADR-0012). `emitPrompt` prints the
 * exact versioned judge prompt for a conversation and writes no run; the calling
 * agent produces the verdict; `recordVerdict` re-validates it through the SAME
 * verdict pipeline the in-process judge uses and persists it, stamped
 * judge_backend=agent. No LLM call is made on either path. Each test runs inside
 * an isolated env (temp REGIMEN_DATA_DIR, temp CODEX_HOME) with stdout/stderr
 * captured by patching the write streams.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitPrompt, recordVerdict } from "../src/cli/index.ts";
import { openStore } from "../src/store.ts";
import { readJudgmentDigest } from "../src/judged/digest.ts";
import type { SetupSource } from "../src/judged/setup.ts";
import { PROMPT_VERSION, RUBRIC_VERSION } from "../src/judged/versions.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";
const NOOP_SETUP_SOURCE: SetupSource = { resolve: () => undefined };

const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];
const MANAGED_ENV = [...HARNESS_MARKERS, "CODEX_HOME", "REGIMEN_DATA_DIR"];

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

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

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

function seedRollout(codexHome: string): void {
  const dir = join(codexHome, "sessions", "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-15T10-00-00-${SESSION}.jsonl`),
    TRANSCRIPT,
  );
}

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<CliResult> {
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
  const exit = await fn();
  return { exit, stdout, stderr };
}

function pinEnv(dataDir: string, codexHome: string): void {
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.REGIMEN_HARNESS = "codex";
  process.env.CODEX_HOME = codexHome;
}

/** A well-formed agent verdict citing chunk ids that exist in the seeded transcript. */
function verdictEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: SESSION,
    promptVersion: PROMPT_VERSION,
    rubricVersion: RUBRIC_VERSION,
    judgeModel: "test-agent-model",
    verdict: {
      intent: { value: "test-writing", anchors: [0] },
      assessment: {
        prose: "The engineer asked for a parser test; the agent delivered it.",
        anchors: [0, 1],
      },
      accomplishment: { value: "accomplished", anchors: [1] },
    },
    ...overrides,
  });
}

test("emit-prompt prints the versioned envelope and writes no run", async () => {
  const dataDir = tempDir("regimen-seam-data-");
  const codexHome = tempDir("regimen-seam-home-");
  seedRollout(codexHome);
  pinEnv(dataDir, codexHome);

  const { exit, stdout } = await capture(() =>
    emitPrompt({ dataDir, session: SESSION, setupSource: NOOP_SETUP_SOURCE }),
  );
  expect(exit).toBe(0);
  const envelope = JSON.parse(stdout);
  expect(envelope.sessionId).toBe(SESSION);
  expect(envelope.promptVersion).toBe(PROMPT_VERSION);
  expect(envelope.rubricVersion).toBe(RUBRIC_VERSION);
  expect(typeof envelope.system).toBe("string");
  expect(envelope.system.length).toBeGreaterThan(0);
  expect(envelope.user).toContain("parser");

  // No run was written by emit-prompt: read the store directly and assert the
  // session is still unjudged.
  const store = openStore(join(dataDir, "feedback.db"));
  try {
    expect(readJudgmentDigest(store.db, SESSION).judged).toBe(false);
  } finally {
    store.close();
  }
});

test("record-verdict validates and persists the agent verdict, stamped judge_backend=agent", async () => {
  const dataDir = tempDir("regimen-seam-data-");
  const codexHome = tempDir("regimen-seam-home-");
  seedRollout(codexHome);
  pinEnv(dataDir, codexHome);

  const { exit, stdout } = await capture(() =>
    recordVerdict({ dataDir, session: SESSION, input: verdictEnvelope() }),
  );
  expect(exit).toBe(0);
  const digest = JSON.parse(stdout);
  expect(digest.judged).toBe(true);
  expect(digest.sessionId).toBe(SESSION);
  expect(digest.provenance.judgeBackend).toBe("agent");
  expect(digest.provenance.judgeModel).toBe("test-agent-model");
  expect(digest.outcome.value).toBe("accomplished-cleanly");
});

test("record-verdict rejects a version mismatch with a re-emit message and writes nothing", async () => {
  const dataDir = tempDir("regimen-seam-data-");
  const codexHome = tempDir("regimen-seam-home-");
  seedRollout(codexHome);
  pinEnv(dataDir, codexHome);

  const { exit, stderr } = await capture(() =>
    recordVerdict({
      dataDir,
      session: SESSION,
      input: verdictEnvelope({ rubricVersion: "1999-01-01" }),
    }),
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("--emit-prompt");
});

test("record-verdict rejects an unanchorable verdict and writes nothing", async () => {
  const dataDir = tempDir("regimen-seam-data-");
  const codexHome = tempDir("regimen-seam-home-");
  seedRollout(codexHome);
  pinEnv(dataDir, codexHome);

  const { exit } = await capture(() =>
    recordVerdict({
      dataDir,
      session: SESSION,
      input: verdictEnvelope({
        verdict: {
          intent: { value: "feature", anchors: [99] },
          assessment: { prose: "unanchorable", anchors: [99] },
        },
      }),
    }),
  );
  expect(exit).toBe(1);

  // Nothing was written: reading the store directly shows no assessment run.
  const store = openStore(join(dataDir, "feedback.db"));
  try {
    expect(readJudgmentDigest(store.db, SESSION).judged).toBe(false);
  } finally {
    store.close();
  }
});

test("record-verdict rejects a session mismatch between the flag and the envelope", async () => {
  const dataDir = tempDir("regimen-seam-data-");
  const codexHome = tempDir("regimen-seam-home-");
  seedRollout(codexHome);
  pinEnv(dataDir, codexHome);

  const { exit, stderr } = await capture(() =>
    recordVerdict({
      dataDir,
      session: SESSION,
      input: verdictEnvelope({ sessionId: "some-other-session" }),
    }),
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("session");
});
