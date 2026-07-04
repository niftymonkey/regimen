/**
 * The `regimen rollup` CLI command, driven IN-PROCESS through the exported
 * `rollup` facade (ADR-0012). The read layer (rollupHeader / collectVerdicts /
 * synthesizeRollup / rollupVerdicts) is unit-tested in rollup.test.ts; this suite
 * covers the CLI surface only: store-dir resolution, the empty-slice
 * short-circuit that resolves no judge backend, the --json VerdictRollup a skill
 * consumes, the rendered narrative-over-numbers human view, and the filter flags
 * reaching the selection. The synthesis model is injected as a mock port so the
 * narrative is deterministic and the suite makes no real model call and never
 * touches the developer's home. Each test runs against a temp REGIMEN_DATA_DIR
 * with stdout/stderr captured by patching the write streams; afterEach restores
 * both the env and the streams so the in-process driving leaves no global state.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { dispatchFeedback } from "./facade-dispatch.ts";
import { openStore } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult, JudgedSignal } from "../src/judged/types.ts";
import type { DerivedOutcomeValue } from "../src/judged/outcome.ts";
import type {
  JudgeModelPort,
  JudgeModelRequest,
  JudgeModelResponse,
} from "../src/judged/port.ts";

const MANAGED_ENV = ["REGIMEN_DATA_DIR", "ANTHROPIC_API_KEY", "PATH"];
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

/** A mock port capturing its request and returning fixed synthesis output. */
function capturingPort(text: string): {
  port: JudgeModelPort;
  calls: JudgeModelRequest[];
} {
  const calls: JudgeModelRequest[] = [];
  return {
    calls,
    port: {
      complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
        calls.push(request);
        return Promise.resolve({ text, model: "mock-judge" });
      },
    },
  };
}

async function runRollup(
  args: ReadonlyArray<string>,
  dataDir: string,
  llm?: JudgeModelPort,
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
  const exit = await dispatchFeedback(
    ["rollup", ...args],
    llm !== undefined ? { llm } : {},
  );
  return { exit, stdout, stderr };
}

function seedConversation(
  db: Database,
  sessionId: string,
  harness: string,
): void {
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, ?, 'the-model', ?, ?)`,
  ).run(
    sessionId,
    harness,
    "2026-06-15T10:00:00.000Z",
    "2026-06-15T10:30:00.000Z",
  );
}

function resultWith(outcome: DerivedOutcomeValue): JudgeResult {
  const signals: JudgedSignal[] = [
    {
      scope: "assignment",
      assignmentId: ASSIGNMENT,
      signalName: "outcome",
      valueKind: "ordinal",
      value: outcome,
      anchors: [{ eventHash: "b".repeat(64) }],
    },
  ];
  return {
    complete: true,
    provenance: {
      judgeModel: "judge-model",
      rubricVersion: "2026-06-15",
      promptVersion: "2026-06-15",
    },
    signals,
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

function judge(
  dataDir: string,
  sessionId: string,
  harness: string,
  outcome: DerivedOutcomeValue,
): void {
  const store = openStore(join(dataDir, "feedback.db"));
  try {
    seedConversation(store.db, sessionId, harness);
    const run: AssessmentRunIdentity = {
      runId: `run-${sessionId}`,
      sessionId,
      assignmentId: ASSIGNMENT,
      createdAt: "2026-06-15T10:00:00.000Z",
    };
    writeAssessment(store, run, resultWith(outcome));
  } finally {
    store.close();
  }
}

test("regimen rollup over no store prints the empty-slice view and resolves no judge", async () => {
  const dataDir = tempDir("regimen-rollup-empty-");
  // No judge backend configured, and no llm injected: a passing empty rollup
  // proves the short-circuit returns before any backend resolution.
  delete process.env.ANTHROPIC_API_KEY;
  const { exit, stdout } = await runRollup(["--json"], dataDir);
  expect(exit).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.header.totalJudged).toBe(0);
  expect(parsed.synthesis).toBeNull();
});

test("regimen rollup over an all-unjudged store short-circuits without a judge backend", async () => {
  const dataDir = tempDir("regimen-rollup-unjudged-");
  delete process.env.ANTHROPIC_API_KEY;
  const store = openStore(join(dataDir, "feedback.db"));
  try {
    seedConversation(store.db, "unjudged-1", "claude");
  } finally {
    store.close();
  }
  const { exit, stdout } = await runRollup([], dataDir);
  expect(exit).toBe(0);
  expect(stdout).toContain("nothing to roll up");
});

test("regimen rollup --json prints the VerdictRollup with the injected synthesis prose", async () => {
  const dataDir = tempDir("regimen-rollup-json-");
  judge(dataDir, "a", "claude", "accomplished-cleanly");
  judge(dataDir, "b", "claude", "partial");
  const { port } = capturingPort("The week went well overall.");

  const { exit, stdout } = await runRollup(["--json"], dataDir, port);
  expect(exit).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.header.totalJudged).toBe(2);
  expect(parsed.synthesis.prose).toBe("The week went well overall.");
  expect(parsed.synthesis.judgeModel).toBe("mock-judge");
});

test("regimen rollup human view leads with the narrative and prints the deterministic numbers beneath", async () => {
  const dataDir = tempDir("regimen-rollup-human-");
  judge(dataDir, "a", "claude", "accomplished-cleanly");
  judge(dataDir, "b", "claude", "partial");
  const { port } = capturingPort("Solid week, one recurring snag.");

  const { exit, stdout } = await runRollup([], dataDir, port);
  expect(exit).toBe(0);
  expect(stdout).toContain("Solid week, one recurring snag.");
  expect(stdout).toContain("The numbers behind this:");
  expect(stdout).toContain("judged conversations: 2");
});

test("regimen rollup exits 1 with a clean stderr when the store cannot be opened", async () => {
  const dataDir = tempDir("regimen-rollup-unopenable-");
  // A directory at the store path passes the existsSync check but makes the
  // Database constructor throw, so this proves a construction failure lands on
  // the graceful stderr-plus-exit-1 path instead of escaping as an unhandled
  // throw (the pattern the sibling list facade already follows).
  mkdirSync(join(dataDir, "feedback.db"));

  const { exit, stderr } = await runRollup(["--json"], dataDir);
  expect(exit).toBe(1);
  expect(stderr.length).toBeGreaterThan(0);
});

test("regimen rollup --harness reaches the selection filter", async () => {
  const dataDir = tempDir("regimen-rollup-filter-");
  judge(dataDir, "a", "claude", "accomplished-cleanly");
  judge(dataDir, "b", "gemini", "partial");
  const { port } = capturingPort("Only the claude slice.");

  const { exit, stdout } = await runRollup(
    ["--harness", "claude", "--json"],
    dataDir,
    port,
  );
  expect(exit).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.header.totalJudged).toBe(1);
  expect(parsed.filter).toEqual({ harness: "claude" });
});
