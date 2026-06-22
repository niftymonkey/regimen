/**
 * The `feedback list` CLI command (B.4), driven IN-PROCESS through the exported
 * `list` facade (ADR-0012). The selection primitive (listSessions) is unit-tested in
 * sessions.test.ts; this suite covers the CLI surface only: store-dir
 * resolution, the human-readable table, the --json array the agent consumes,
 * filter flags reaching the primitive, the missing-store empty path, and the
 * unparseable-bound error. Each test runs against a temp REGIMEN_DATA_DIR with
 * stdout/stderr captured by patching the write streams; afterEach restores both
 * the env and the streams so the in-process driving leaves no global state.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { dispatchFeedback } from "./facade-dispatch.ts";
import { openStore } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult, OutcomeValue } from "../src/judged/types.ts";

const MANAGED_ENV = ["REGIMEN_DATA_DIR"];
const ASSIGNMENT = "whole-conversation";

let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
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

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runList(
  args: ReadonlyArray<string>,
  dataDir: string,
): Promise<CliResult> {
  process.env.REGIMEN_DATA_DIR = dataDir;
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
  const exit = await dispatchFeedback(["list", ...args]);
  return { exit, stdout, stderr };
}

function seedSession(
  db: Database,
  opts: {
    sessionId: string;
    harness: string;
    model: string | null;
    firstEventAt: string;
    lastEventAt: string;
  },
): void {
  // Insert events directly (not via the typed loader) so a test can seed an
  // arbitrary harness string; the count view reads the events table.
  db.prepare(
    `INSERT OR IGNORE INTO events
       (event_hash, schema_version, trace_id, session_id, timestamp,
        harness, model, event_type, span_phase, span_name, attributes)
     VALUES (randomblob(32), 1, ?, ?, ?, ?, ?, 'user_prompt', 'point', 'user_prompt', '{}')`,
  ).run(
    `trace-${opts.sessionId}`,
    opts.sessionId,
    opts.lastEventAt,
    opts.harness,
    opts.model,
  );
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.sessionId,
    opts.harness,
    opts.model,
    opts.firstEventAt,
    opts.lastEventAt,
  );
}

function run(sessionId: string, runId: string): AssessmentRunIdentity {
  return {
    runId,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-06-15T10:00:00.000Z",
  };
}

function resultWithOutcome(outcome: OutcomeValue): JudgeResult {
  return {
    complete: true,
    provenance: {
      judgeModel: "judge-model",
      rubricVersion: "2026-06-15",
      promptVersion: "2026-06-15",
    },
    signals: [
      {
        scope: "assignment",
        assignmentId: ASSIGNMENT,
        signalName: "outcome",
        valueKind: "ordinal",
        value: outcome,
        anchors: [{ eventHash: "b".repeat(64) }],
      },
    ],
    narratives: [
      {
        scope: "conversation",
        narrativeType: "assessment",
        prose: "The agent built the feature.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

/** Seed a temp data dir with a store holding a judged and an unjudged session. */
function seedDataDir(): string {
  const dataDir = tempDir("regimen-list-cli-");
  const store = openStore(join(dataDir, "feedback.db"));
  try {
    seedSession(store.db, {
      sessionId: "11111111-aaaa-7000-8000-000000000001",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    writeAssessment(
      store,
      run("11111111-aaaa-7000-8000-000000000001", "run-1"),
      resultWithOutcome("accomplished-cleanly"),
    );
    seedSession(store.db, {
      sessionId: "22222222-bbbb-7000-8000-000000000002",
      harness: "gemini",
      model: "gemini-2.5",
      firstEventAt: "2026-06-14T09:00:00.000Z",
      lastEventAt: "2026-06-14T09:15:00.000Z",
    });
  } finally {
    store.close();
  }
  return dataDir;
}

test("feedback list --json prints the full SessionSummary array, newest first", async () => {
  const dataDir = seedDataDir();
  const { exit, stdout } = await runList(["--json"], dataDir);
  expect(exit).toBe(0);
  const rows = JSON.parse(stdout);
  expect(rows.map((r: { sessionId: string }) => r.sessionId)).toEqual([
    "11111111-aaaa-7000-8000-000000000001",
    "22222222-bbbb-7000-8000-000000000002",
  ]);
  expect(rows[0]).toEqual({
    sessionId: "11111111-aaaa-7000-8000-000000000001",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T10:00:00.000Z",
    lastEventAt: "2026-06-15T10:30:00.000Z",
    eventCount: 1,
    judged: true,
    outcome: "accomplished-cleanly",
  });
});

test("feedback list prints a human-readable table with a count footer", async () => {
  const dataDir = seedDataDir();
  const { exit, stdout } = await runList([], dataDir);
  expect(exit).toBe(0);
  // One row per session, plus a footer naming the count.
  expect(stdout).toContain("claude");
  expect(stdout).toContain("gemini");
  expect(stdout).toContain("accomplished-cleanly");
  expect(stdout).toContain("2 sessions");
});

test("feedback list --harness reaches the primitive's harness filter", async () => {
  const dataDir = seedDataDir();
  const { exit, stdout } = await runList(
    ["--harness", "gemini", "--json"],
    dataDir,
  );
  expect(exit).toBe(0);
  const rows = JSON.parse(stdout);
  expect(rows.map((r: { sessionId: string }) => r.sessionId)).toEqual([
    "22222222-bbbb-7000-8000-000000000002",
  ]);
});

test("feedback list --outcome reaches the primitive's outcome filter", async () => {
  const dataDir = seedDataDir();
  const { exit, stdout } = await runList(
    ["--outcome", "accomplished-cleanly", "--json"],
    dataDir,
  );
  expect(exit).toBe(0);
  const rows = JSON.parse(stdout);
  expect(rows.map((r: { sessionId: string }) => r.sessionId)).toEqual([
    "11111111-aaaa-7000-8000-000000000001",
  ]);
});

test("feedback list with no store prints an empty result and exits 0", async () => {
  const dataDir = tempDir("regimen-list-empty-");
  const { exit, stdout } = await runList(["--json"], dataDir);
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual([]);
});

test("feedback list with no store and no --json prints a clean zero-count line", async () => {
  const dataDir = tempDir("regimen-list-empty-table-");
  const { exit, stdout } = await runList([], dataDir);
  expect(exit).toBe(0);
  expect(stdout).toContain("0 sessions");
});

test("feedback list with an unparseable --since exits 1 with a clear error", async () => {
  const dataDir = seedDataDir();
  const { exit, stderr } = await runList(["--since", "last-tuesday"], dataDir);
  expect(exit).toBe(1);
  expect(stderr).toContain("could not parse since");
});
