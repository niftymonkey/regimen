/**
 * The `regimen calibrate` FACADE, driven in-process against a temp data dir,
 * config dir, and codex home. A candidate JudgeModelPort stub stands in for the
 * candidate judge and a no-op setup source keeps the run hermetic (no real home
 * read, no network). The tests pin the read-only guarantee end to end (no new
 * assessment run after a calibrate pass), the golden-file default, and the
 * --save-golden round-trip.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibrate } from "../src/cli/index.ts";
import { assessConversation } from "../src/judged/assess.ts";
import { readGolden, writeGolden } from "../src/judged/golden.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";
import type { SetupSource } from "../src/judged/setup.ts";
import { openStore } from "../src/store.ts";
import { rolloutContent } from "../src/loader/rollout/codex-reader.ts";

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
let savedStdout: typeof process.stdout.write;
let savedStderr: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  for (const marker of HARNESS_MARKERS) delete process.env[marker];
  savedStdout = process.stdout.write.bind(process.stdout);
  savedStderr = process.stderr.write.bind(process.stderr);
});

afterEach(() => {
  process.stdout.write = savedStdout;
  process.stderr.write = savedStderr;
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

/** A candidate verdict citing the transcript's chunk ids, matching the baseline. */
function candidateVerdict(): string {
  const chunks = rolloutContent(TRANSCRIPT);
  const human = chunks.find((c) => c.kind === "human_prompt")!;
  const answer = chunks.find((c) => c.kind === "assistant_answer")!;
  return JSON.stringify({
    intent: { value: "test-writing", anchors: [human.lineSeq] },
    assessment: {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [human.lineSeq, answer.lineSeq],
    },
    accomplishment: { value: "accomplished", anchors: [answer.lineSeq] },
  });
}

function candidatePort(text: string): JudgeModelPort {
  return {
    complete(): Promise<JudgeModelResponse> {
      return Promise.resolve({ text, model: "candidate-model" });
    },
  };
}

/** Seed the on-disk store: a conversations row and a baseline verdict for SESSION. */
async function seedStore(dataDir: string, codexHome: string): Promise<void> {
  const store = openStore(join(dataDir, "feedback.db"));
  store.db
    .prepare(
      `INSERT INTO conversations (session_id, harness, model, first_event_at, last_event_at)
       VALUES (?, 'codex', 'gpt-5', '2026-06-15T10:00:00.000Z', '2026-06-15T10:00:02.000Z')`,
    )
    .run(SESSION);
  await assessConversation({
    store,
    harness: "codex",
    sessionsDir: join(codexHome, "sessions"),
    sessionId: SESSION,
    llm: candidatePort(candidateVerdict()),
    runId: "baseline",
    now: () => new Date("2026-06-15T12:00:00.000Z"),
  });
  store.close();
}

function runCount(dataDir: string): number {
  const store = openStore(join(dataDir, "feedback.db"));
  const n = (
    store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
      n: number;
    }
  ).n;
  store.close();
  return n;
}

async function capture(fn: () => Promise<number>): Promise<{
  exit: number;
  stdout: string;
  stderr: string;
}> {
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

test("calibrate over an ad-hoc --sessions list passes and writes no new assessment run", async () => {
  const dataDir = tempDir("regimen-calibrate-data-");
  const codexHome = tempDir("regimen-calibrate-home-");
  const configDir = tempDir("regimen-calibrate-config-");
  seedRollout(codexHome);
  await seedStore(dataDir, codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.REGIMEN_HARNESS = "codex";

  const before = runCount(dataDir);

  const { exit, stdout } = await capture(() =>
    calibrate({
      dataDir,
      configDir,
      mode: "calibration",
      sessionIds: [SESSION],
      candidate: candidatePort(candidateVerdict()),
      setupSource: NOOP_SETUP_SOURCE,
    }),
  );

  expect(exit).toBe(0);
  expect(stdout).toContain("PASS");
  expect(runCount(dataDir)).toBe(before);
});

test("calibrate defaults to the golden set when no --sessions is given", async () => {
  const dataDir = tempDir("regimen-calibrate-data-");
  const codexHome = tempDir("regimen-calibrate-home-");
  const configDir = tempDir("regimen-calibrate-config-");
  seedRollout(codexHome);
  await seedStore(dataDir, codexHome);
  writeGolden(configDir, [{ sessionId: SESSION }]);
  process.env.CODEX_HOME = codexHome;
  process.env.REGIMEN_HARNESS = "codex";

  const { exit, stdout } = await capture(() =>
    calibrate({
      dataDir,
      configDir,
      mode: "calibration",
      candidate: candidatePort(candidateVerdict()),
      setupSource: NOOP_SETUP_SOURCE,
    }),
  );

  expect(exit).toBe(0);
  expect(stdout).toContain(SESSION.slice(0, 8));
});

test("calibrate with neither --sessions nor a golden set fails closed", async () => {
  const dataDir = tempDir("regimen-calibrate-data-");
  const configDir = tempDir("regimen-calibrate-config-");

  const { exit, stderr } = await capture(() =>
    calibrate({
      dataDir,
      configDir,
      mode: "calibration",
      candidate: candidatePort(candidateVerdict()),
      setupSource: NOOP_SETUP_SOURCE,
    }),
  );

  expect(exit).toBe(1);
  expect(stderr).toContain("no sessions to calibrate");
});

test("--save-golden writes the --sessions list to the golden file and exits without judging", async () => {
  const dataDir = tempDir("regimen-calibrate-data-");
  const configDir = tempDir("regimen-calibrate-config-");

  const { exit } = await capture(() =>
    calibrate({
      dataDir,
      configDir,
      mode: "calibration",
      sessionIds: ["aaa", "bbb"],
      saveGolden: true,
      candidate: candidatePort(candidateVerdict()),
      setupSource: NOOP_SETUP_SOURCE,
    }),
  );

  expect(exit).toBe(0);
  expect(readGolden(configDir)).toEqual([
    { sessionId: "aaa" },
    { sessionId: "bbb" },
  ]);
});
