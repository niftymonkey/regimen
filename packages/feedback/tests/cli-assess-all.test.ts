/**
 * The `regimen assess --all` sweep facade, driven IN-PROCESS through the exported
 * `assessAll` function. Each conversation is judged exactly as single-session
 * `assess` is, against a LOCAL mock Anthropic server (ANTHROPIC_BASE_URL) so the
 * judge round-trip is real wire shape but makes ZERO network calls off the
 * machine. The interactive between-batch decision is injected, so the sweep runs
 * without a terminal. Selection reads the `conversations` table (seeded here as
 * the loader would), and persisted verdicts are read back through listSessions.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openStore } from "../src/store.ts";
import { listSessions } from "../src/sessions.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult, OutcomeValue } from "../src/judged/types.ts";
import type { BatchDecision } from "../src/judged/sweep.ts";
import { assessAll } from "../src/cli/index.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";
const OTHER = "019e8c20-4491-7ea3-b809-000000000002";

const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];

const MANAGED_ENV = [
  ...HARNESS_MARKERS,
  "CODEX_HOME",
  "REGIMEN_DATA_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "PATH",
];

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

/** A small but real Codex rollout for `sessionId`: meta, a prompt, an answer. */
function transcriptFor(sessionId: string): string {
  return [
    line({
      timestamp: "2026-06-15T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
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
        content: [
          { type: "output_text", text: "Done, the parser test passes." },
        ],
      },
    }),
  ].join("\n");
}

/** Seed `sessionId`'s rollout as the only one for that id under CODEX_HOME. */
function seedRollout(codexHome: string, sessionId: string): void {
  const dir = join(codexHome, "sessions", "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-15T10-00-00-${sessionId}.jsonl`),
    transcriptFor(sessionId),
  );
}

/** Insert a conversations row so the sweep's selection finds the session. */
function seedConversation(
  dbPath: string,
  opts: { sessionId: string; lastEventAt: string },
): void {
  const store = openStore(dbPath);
  try {
    store.db
      .prepare(
        `INSERT INTO conversations
           (session_id, harness, model, first_event_at, last_event_at)
         VALUES (?, 'codex', 'gpt-5', ?, ?)`,
      )
      .run(opts.sessionId, opts.lastEventAt, opts.lastEventAt);
  } finally {
    store.close();
  }
}

/** Mark `sessionId` already judged by persisting a complete assessment. */
function prejudge(dbPath: string, sessionId: string): void {
  const store = openStore(dbPath);
  try {
    const run: AssessmentRunIdentity = {
      runId: `run-${sessionId}`,
      sessionId,
      assignmentId: "whole-conversation",
      createdAt: "2026-06-15T10:00:00.000Z",
    };
    const result: JudgeResult = {
      complete: true,
      provenance: {
        judgeModel: "judge-model",
        rubricVersion: "2026-06-15",
        promptVersion: "2026-06-15",
      },
      signals: [
        {
          scope: "assignment",
          assignmentId: "whole-conversation",
          signalName: "outcome",
          valueKind: "ordinal",
          value: "accomplished-cleanly" as OutcomeValue,
          anchors: [{ eventHash: "b".repeat(64) }],
        },
      ],
      narratives: [
        {
          scope: "conversation",
          narrativeType: "assessment",
          prose: "Already judged in an earlier sweep.",
          anchors: [{ eventHash: "a".repeat(64) }],
        },
      ],
    };
    writeAssessment(store, run, result);
  } finally {
    store.close();
  }
}

/**
 * A local HTTP server answering /v1/messages with a canned verdict citing chunk
 * ids 0 and 1, as the real judge would, and counting the requests it serves.
 * Nothing leaves the machine.
 */
function startMockAnthropic(): {
  baseUrl: string;
  stop: () => void;
  count: () => number;
} {
  const verdict = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [0, 1],
    },
    outcome: { value: "accomplished-cleanly", anchors: [1] },
  });
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      hits++;
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
    count: () => hits,
  };
}

function captureStdout(): { read: () => string } {
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  return { read: () => out };
}

function captureStderr(): { read: () => string } {
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  return { read: () => out };
}

function isJudged(dbPath: string, sessionId: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = listSessions(db).find((s) => s.sessionId === sessionId);
    return row?.judged ?? false;
  } finally {
    db.close();
  }
}

const ALWAYS_CONTINUE = async (): Promise<BatchDecision> => "continue";

test("assessAll judges an unjudged conversation by its own harness and persists the verdict", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  captureStdout();
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 10,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    expect(isJudged(dbPath, SESSION)).toBe(true);
  } finally {
    mock.stop();
  }
});

test("assessAll prints the opening accounting and judges only the unjudged conversation", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  // A: already judged (no rollout, must never be re-judged).
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  prejudge(dbPath, SESSION);
  // B: unjudged, with a transcript to judge.
  seedConversation(dbPath, {
    sessionId: OTHER,
    lastEventAt: "2026-06-15T09:30:00.000Z",
  });
  seedRollout(codexHome, OTHER);
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  const stdout = captureStdout();
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 10,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    const out = stdout.read();
    expect(out).toContain("matched 2");
    expect(out).toContain("already judged 1");
    expect(out).toContain("to judge 1");
    // Only the unjudged conversation reached the judge.
    expect(mock.count()).toBe(1);
    expect(isJudged(dbPath, OTHER)).toBe(true);
  } finally {
    mock.stop();
  }
});

test("assessAll continues past a missing transcript and reports it in the end summary", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  // A: unjudged with a transcript (judges cleanly).
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  // B: unjudged with NO transcript on disk (the judge throws; sweep continues).
  seedConversation(dbPath, {
    sessionId: OTHER,
    lastEventAt: "2026-06-15T09:30:00.000Z",
  });
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  const stdout = captureStdout();
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 10,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    const out = stdout.read();
    expect(out).toContain("done: judged 1");
    expect(out).toContain("failed 1");
    expect(out).toContain("skipped 0");
    // The failure prints inline with contiguous numbering (SESSION is index 1,
    // OTHER index 2), so the progress has no gaps where a judge threw.
    expect(out).toContain(`[2/2] codex ${OTHER} -> FAILED`);
    // It is also named in the end summary, so a large sweep is debuggable
    // without re-deriving which one broke.
    expect(out).toContain(`failed: codex ${OTHER}`);
    expect(isJudged(dbPath, SESSION)).toBe(true);
    expect(isJudged(dbPath, OTHER)).toBe(false);
  } finally {
    mock.stop();
  }
});

test("assessAll prints a per-conversation progress line carrying the outcome", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  const stdout = captureStdout();
  try {
    await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 10,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    const out = stdout.read();
    expect(out).toContain(SESSION);
    expect(out).toContain("accomplished-cleanly");
  } finally {
    mock.stop();
  }
});

test("assessAll with no judge backend exits 1 with a clear error and no rejection", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  // No ANTHROPIC_API_KEY and an empty PATH so the CLI judge fallback finds no
  // `claude`: resolving the judge backend fails, which must land on the clean
  // stderr-plus-exit-1 path rather than escaping as an unhandled rejection.
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = "";
  captureStdout();
  const stderr = captureStderr();
  const exit = await assessAll({
    dataDir,
    filter: {},
    force: false,
    batchSize: 10,
    decideNextBatch: ALWAYS_CONTINUE,
  });
  expect(exit).toBe(1);
  const err = stderr.read();
  expect(err).toContain("ANTHROPIC_API_KEY");
  expect(err).not.toContain("    at ");
});

test("assessAll with force re-judges an already-judged conversation", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  prejudge(dbPath, SESSION);
  // The transcript must exist for the re-judge to read it.
  seedRollout(codexHome, SESSION);
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  const stdout = captureStdout();
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: true,
      batchSize: 10,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    expect(stdout.read()).toContain("to judge 1");
    // Already-judged, but force sent it back to the judge.
    expect(mock.count()).toBe(1);
  } finally {
    mock.stop();
  }
});

test("assessAll quits between batches and reports the remainder as skipped", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  seedConversation(dbPath, {
    sessionId: OTHER,
    lastEventAt: "2026-06-15T09:30:00.000Z",
  });
  seedRollout(codexHome, OTHER);
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  const stdout = captureStdout();
  const quit = async (): Promise<BatchDecision> => "quit";
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 1,
      decideNextBatch: quit,
    });
    expect(exit).toBe(0);
    const out = stdout.read();
    expect(out).toContain("done: judged 1");
    expect(out).toContain("skipped 1");
    // Only the first batch ran before the quit.
    expect(mock.count()).toBe(1);
    expect(isJudged(dbPath, SESSION)).toBe(true);
    expect(isJudged(dbPath, OTHER)).toBe(false);
  } finally {
    mock.stop();
  }
});
