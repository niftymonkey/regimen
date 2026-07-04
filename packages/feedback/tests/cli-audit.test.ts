/**
 * The `regimen audit` CLI command (ADR-0016 capability 2), driven IN-PROCESS
 * through the exported `audit` facade (ADR-0012) rather than by spawning a bun
 * subprocess. The all-healthy path is hermetic: it seeds working practices, injects
 * a stub setup source (so the live adapter never reads the developer's real home),
 * and asserts the audit prints a health summary WITHOUT any judge backend, since a
 * clean audit makes no paid model call. stdout/stderr are captured by patching the
 * write streams; afterEach restores the env and streams.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStore } from "../src/store.ts";
import { dispatchFeedback } from "./facade-dispatch.ts";
import type { SetupSource } from "../src/judged/setup.ts";

/** A setup source reporting a fixed set of practices in force now. */
function setupSourceWith(names: ReadonlyArray<string>): SetupSource {
  return {
    resolve: () => ({
      conventions: [],
      practices: names.map((name) => ({ name, summary: name })),
    }),
  };
}

const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];
const MANAGED_ENV = [
  ...HARNESS_MARKERS,
  "REGIMEN_DATA_DIR",
  "ANTHROPIC_API_KEY",
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

function seedWorkingPractice(db: Database, name: string): void {
  for (const id of ["s1", "s2", "s3"]) {
    db.prepare(
      `INSERT INTO conversations
         (session_id, harness, model, first_event_at, last_event_at)
       VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
    ).run(id, "2026-06-15T10:00:00.000Z", "2026-06-15T10:00:00.000Z");
    db.prepare(
      `INSERT INTO conversation_setup_snapshot
         (session_id, captured_at, practices, conventions)
       VALUES (?, '2026-06-15T10:00:00.000Z', ?, '[]')`,
    ).run(id, JSON.stringify([{ name }]));
  }
  db.prepare(
    `INSERT INTO skill_invocations
       (session_id, skill_name, invocation_count, last_invoked_at)
     VALUES ('s1', ?, 2, '2026-06-15T10:05:00.000Z')`,
  ).run(name);
}

async function runAudit(
  dataDir: string,
  setupSource: SetupSource,
): Promise<{ exit: number; stdout: string; stderr: string }> {
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
  const exit = await dispatchFeedback(["audit"], { setupSource });
  return { exit, stdout, stderr };
}

test("audit of an all-healthy setup prints a summary and makes no model call", async () => {
  const dataDir = tempDir("regimen-audit-cli-");
  const store = openStore(join(dataDir, "feedback.db"));
  seedWorkingPractice(store.db, "tdd");
  store.close();

  // No ANTHROPIC_API_KEY is pinned: a clean audit must not resolve a judge
  // backend, so the command succeeds with no key configured.
  delete process.env.ANTHROPIC_API_KEY;
  const { exit, stdout, stderr } = await runAudit(
    dataDir,
    setupSourceWith(["tdd"]),
  );

  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("tdd");
});

test("audit with no store at all reports there is nothing to audit yet", async () => {
  const dataDir = tempDir("regimen-audit-empty-");
  const { exit, stdout } = await runAudit(dataDir, {
    resolve: () => undefined,
  });
  expect(exit).toBe(0);
  expect(stdout.toLowerCase()).toContain("nothing to audit");
});
