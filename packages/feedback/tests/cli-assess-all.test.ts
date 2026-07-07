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
import type { JudgeResult } from "../src/judged/types.ts";
import type { DerivedOutcomeValue } from "../src/judged/outcome.ts";
import type { BatchDecision } from "../src/judged/sweep.ts";
import type { SetupSource } from "../src/judged/setup.ts";
import { assessAll } from "../src/cli/index.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";
const OTHER = "019e8c20-4491-7ea3-b809-000000000002";
const CLAUDE_SESSION = "08551ace-1f3c-40b2-a088-ef00ce37027f";

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
  "CLAUDE_CONFIG_DIR",
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

/** A rollout carrying only session_meta: zero content chunks (insufficient-evidence). */
function emptyRolloutFor(sessionId: string): string {
  return line({
    timestamp: "2026-06-15T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: "/work/p",
      originator: "codex_exec",
      source: "exec",
    },
  });
}

/** Seed `sessionId`'s empty rollout (no message content) under CODEX_HOME. */
function seedEmptyRollout(codexHome: string, sessionId: string): void {
  const dir = join(codexHome, "sessions", "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-15T10-00-00-${sessionId}.jsonl`),
    emptyRolloutFor(sessionId),
  );
}

/**
 * Insert a conversations row so the sweep's selection finds the session. The
 * harness and model default to codex/gpt-5 so the existing codex callers stay
 * unchanged; a mixed-harness test passes `harness` to seed a non-codex row whose
 * verdict must resolve through that harness's own adapter path.
 */
function seedConversation(
  dbPath: string,
  opts: {
    sessionId: string;
    lastEventAt: string;
    harness?: string;
    model?: string;
  },
): void {
  const harness = opts.harness ?? "codex";
  const model = opts.model ?? "gpt-5";
  const store = openStore(dbPath);
  try {
    store.db
      .prepare(
        `INSERT INTO conversations
           (session_id, harness, model, first_event_at, last_event_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(opts.sessionId, harness, model, opts.lastEventAt, opts.lastEventAt);
  } finally {
    store.close();
  }
}

/** A small but real-shape Claude transcript: a prompt and an assistant answer. */
function claudeTranscriptFor(sessionId: string): string {
  return [
    line({
      type: "user",
      cwd: "/work/p",
      message: { role: "user", content: "add a test for the parser" },
      sessionId,
      timestamp: "2026-06-15T10:00:01.000Z",
      uuid: "u-1",
    }),
    line({
      type: "assistant",
      cwd: "/work/p",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Done, the parser test passes." }],
      },
      sessionId,
      timestamp: "2026-06-15T10:00:02.000Z",
      uuid: "u-2",
    }),
  ].join("\n");
}

/**
 * Seed `sessionId`'s Claude transcript under CLAUDE_CONFIG_DIR. Claude Code
 * writes one transcript per session at `<configHome>/projects/<cwd-slug>/<id>.jsonl`;
 * the slug is arbitrary because `locateClaudeTranscript` matches on the base name
 * (`<id>.jsonl`), so the claude conversation is found only when the sweep resolves
 * the claude config home, not the codex one.
 */
function seedClaudeTranscript(configHome: string, sessionId: string): void {
  const dir = join(configHome, "projects", "-work-p");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    claudeTranscriptFor(sessionId),
  );
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
          value: "accomplished-cleanly" as DerivedOutcomeValue,
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
    accomplishment: { value: "accomplished", anchors: [1] },
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

/**
 * A local HTTP server whose /v1/messages reply is never valid verdict JSON, so
 * every judge attempt (the initial call plus every repair retry) exhausts the
 * Judge's retry budget and resolves incomplete with incompleteReason
 * "llm-unparseable". Nothing leaves the machine.
 */
function startMockAnthropicUnparseable(): {
  baseUrl: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "not a verdict, just prose" }],
        stop_reason: "end_turn",
      });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

/**
 * Like {@link startMockAnthropic} but also records the raw request body of each
 * call, so a test can assert on the prompt that reached the judge (e.g. that the
 * injected setup was threaded through). Nothing leaves the machine.
 */
function startCapturingMockAnthropic(): {
  baseUrl: string;
  stop: () => void;
  count: () => number;
  lastBody: () => string | undefined;
} {
  const verdict = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [0, 1],
    },
    accomplishment: { value: "accomplished", anchors: [1] },
  });
  let hits = 0;
  let lastBody: string | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      hits++;
      lastBody = await req.text();
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
    lastBody: () => lastBody,
  };
}

/** A recognizable convention text a stub setup source carries into the prompt. */
const SWEEP_CONVENTION = "SWEEP-STUB-CONVENTION honored";

/** A stub SetupSource returning a fixed EngineerSetup for any cwd/asOf. */
function stubSetupSource(): SetupSource {
  return {
    resolve() {
      return {
        conventions: [{ scope: "project", text: SWEEP_CONVENTION }],
        practices: [],
      };
    },
  };
}

/**
 * A no-op setup source: resolve always returns undefined, so the judge stays
 * setup-blind exactly as it was before setup wiring. Injected into every sweep
 * call that does NOT assert setup behavior, so those cases never reach the live
 * adapter default, which would otherwise read the developer's real home
 * (CLAUDE.md / skills), making the test non-hermetic. The canned mock judge
 * ignores prompt content, so the verdict assertions are unchanged.
 */
const NOOP_SETUP_SOURCE: SetupSource = { resolve: () => undefined };

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
      setupSource: NOOP_SETUP_SOURCE,
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
      setupSource: NOOP_SETUP_SOURCE,
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

test("assessAll marks a missing transcript, reports it in the missing bucket, and excludes it on a re-sweep", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  // A: unjudged with a transcript (judges cleanly).
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  // B: unjudged with NO transcript on disk (the judge throws the typed
  // transcript-missing error; the sweep marks it and continues).
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
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    const out = stdout.read();
    // A gone transcript is its own honest bucket, not a generic failure.
    expect(out).toContain("done: judged 1");
    expect(out).toContain("missing 1");
    expect(out).toContain("failed 0");
    expect(out).toContain("skipped 0");
    // It prints inline with contiguous numbering (SESSION index 1, OTHER index
    // 2), so the progress has no gaps.
    expect(out).toContain(`[2/2] codex ${OTHER} -> MISSING`);
    // It is named in the end summary so a large sweep stays debuggable.
    expect(out).toContain(`missing: codex ${OTHER}`);
    expect(isJudged(dbPath, SESSION)).toBe(true);
    expect(isJudged(dbPath, OTHER)).toBe(false);
  } finally {
    mock.stop();
  }

  // A second sweep no longer offers the marked session: it is durably excluded
  // from selection, so "to judge" drops it and the judge is never re-invoked.
  const stdout2 = captureStdout();
  const mock2 = startMockAnthropic();
  process.env.ANTHROPIC_BASE_URL = mock2.baseUrl;
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 10,
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    // SESSION is already judged and OTHER is transcript-missing, so nothing is
    // selected; the marked session never reaches the judge again. The header
    // keeps the two buckets disjoint: one judged, one missing, never folding the
    // missing session into "already judged".
    const header2 = stdout2.read();
    expect(header2).toContain("already judged 1");
    expect(header2).toContain("missing 1");
    expect(header2).toContain("to judge 0");
    expect(mock2.count()).toBe(0);
  } finally {
    mock2.stop();
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
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    const out = stdout.read();
    expect(out).toContain(SESSION);
    expect(out).toContain("accomplished-cleanly");
  } finally {
    mock.stop();
  }
});

test("assessAll's done line breaks the judged total into complete, signals-only, and incomplete", async () => {
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
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    const out = stdout.read();
    // The clean mock verdict carries signals and an assessment narrative, so it
    // lands in the complete bucket and the honest breakdown says so.
    expect(out).toContain(
      "done: judged 1 (complete 1, signals-only 0, incomplete 0)",
    );
  } finally {
    mock.stop();
  }
});

test("an incomplete sweep line and the done summary surface why, per session and as a breakdown", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  // SESSION judges against a backend that never returns valid verdict JSON:
  // llm-unparseable after the retry budget is exhausted.
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  // OTHER has no content chunks at all: insufficient-evidence, no LLM call.
  seedConversation(dbPath, {
    sessionId: OTHER,
    lastEventAt: "2026-06-15T09:30:00.000Z",
  });
  seedEmptyRollout(codexHome, OTHER);
  const mock = startMockAnthropicUnparseable();
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
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    const out = stdout.read();
    expect(out).toContain(`${SESSION} -> incomplete (llm-unparseable)`);
    expect(out).toContain(`${OTHER} -> incomplete (insufficient-evidence)`);
    expect(out).toContain(
      "done: judged 2 (complete 0, signals-only 0, incomplete 2)",
    );
    expect(out).toContain(
      "incomplete reasons: insufficient-evidence 1, llm-unparseable 1",
    );
    // Mixed reasons, so the uniform-cause advisory line does not fire.
    expect(out).not.toContain("every verdict failed the same way");
  } finally {
    mock.stop();
  }
});

test("when every incomplete verdict shares the same reason, the summary says so plainly", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  const mock = startMockAnthropicUnparseable();
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
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    const out = stdout.read();
    expect(out).toContain(
      "every verdict failed the same way (llm-unparseable); check the judge backend (see --judge-via)",
    );
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
    setupSource: NOOP_SETUP_SOURCE,
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
      setupSource: NOOP_SETUP_SOURCE,
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

test("assessAll --force re-judges using the setup-aware prompt from the injected source", async () => {
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const dbPath = join(dataDir, "feedback.db");
  // Already judged, so only --force sends it back to the judge.
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  prejudge(dbPath, SESSION);
  // The transcript must exist for the re-judge to read it.
  seedRollout(codexHome, SESSION);
  const mock = startCapturingMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  captureStdout();
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: true,
      batchSize: 10,
      setupSource: stubSetupSource(),
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    // Force sent the already-judged conversation back to the judge,
    expect(mock.count()).toBe(1);
    // and the prompt that reached the judge carried the injected setup, so the
    // sweep re-judges with the enriched (setup-aware) prompt.
    expect(mock.lastBody()).toContain(SWEEP_CONVENTION);
  } finally {
    mock.stop();
  }
});

test("assessAll judges each conversation through its OWN harness in a mixed sweep", async () => {
  // Two conversations resolving through DIFFERENT adapter paths: a codex rollout
  // under CODEX_HOME/sessions and a claude transcript under CLAUDE_CONFIG_DIR/projects.
  // assessAll resolves the harness location PER conversation, so both are found
  // and judged. A regression that resolved the location once for the whole sweep
  // would point both lookups at one harness home: the off-harness transcript
  // would not be found there, that conversation would FAIL, and the matching
  // isJudged assertion below would go false.
  const dataDir = tempDir("regimen-sweep-cli-");
  const codexHome = tempDir("regimen-sweep-home-");
  const claudeHome = tempDir("regimen-sweep-claude-");
  const dbPath = join(dataDir, "feedback.db");
  // The codex conversation is the newest, so a once-per-sweep resolution would
  // bind the codex home first and then fail to find the claude transcript there.
  seedConversation(dbPath, {
    sessionId: SESSION,
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedRollout(codexHome, SESSION);
  seedConversation(dbPath, {
    sessionId: CLAUDE_SESSION,
    lastEventAt: "2026-06-15T09:30:00.000Z",
    harness: "claude",
    model: "claude-opus-4-8",
  });
  seedClaudeTranscript(claudeHome, CLAUDE_SESSION);
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  captureStdout();
  try {
    const exit = await assessAll({
      dataDir,
      filter: {},
      force: false,
      batchSize: 10,
      setupSource: NOOP_SETUP_SOURCE,
      decideNextBatch: ALWAYS_CONTINUE,
    });
    expect(exit).toBe(0);
    // Both reached the judge and both persisted a verdict, each via its own
    // harness adapter (codex rollout reader and claude transcript reader).
    expect(mock.count()).toBe(2);
    expect(isJudged(dbPath, SESSION)).toBe(true);
    expect(isJudged(dbPath, CLAUDE_SESSION)).toBe(true);
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
      setupSource: NOOP_SETUP_SOURCE,
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
