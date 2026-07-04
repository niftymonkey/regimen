/**
 * The conversation-time setup-provenance snapshot (ADR-0017, migration v7).
 * When assess (or the emit half of the agent seam) resolves the engineer's
 * setup for a conversation, it must persist a time-scoped echo in
 * `conversation_setup_snapshot`: the roster names and per-convention content
 * hashes as of the conversation, not as of now. No setup resolved writes no
 * row; a re-assess upserts by session id.
 */
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import { assessConversation } from "../src/judged/assess.ts";
import { emitPrompt, recordVerdict } from "../src/judged/agent-seam.ts";
import { rolloutContent } from "../src/loader/rollout/codex-reader.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";
import type { SetupSource } from "../src/judged/setup.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real Codex rollout; its latest event timestamp is the asOf. */
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

const LATEST_EVENT_TIMESTAMP = "2026-06-15T10:00:02.000Z";

function seedRollout(sessionsDir: string, content = TRANSCRIPT): void {
  const dir = join(sessionsDir, "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-15T10-00-00-${SESSION}.jsonl`),
    content,
  );
}

interface Harness {
  store: Store;
  sessionsDir: string;
}

function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "regimen-setup-snapshot-"));
  const store = openStore(":memory:");
  const sessionsDir = join(root, "sessions");
  return fn({ store, sessionsDir }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

function stubJudgeModel(content: string): JudgeModelPort {
  const chunks = rolloutContent(content);
  const human = chunks.find((c) => c.kind === "human_prompt")!;
  const answer = chunks.find((c) => c.kind === "assistant_answer")!;
  const verdict = JSON.stringify({
    intent: { value: "test-writing", anchors: [human.lineSeq] },
    assessment: {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [human.lineSeq, answer.lineSeq],
    },
    accomplishment: { value: "accomplished", anchors: [answer.lineSeq] },
  });
  return {
    complete(): Promise<JudgeModelResponse> {
      return Promise.resolve({ text: verdict, model: "claude-opus-4-8" });
    },
  };
}

const CONVENTION_TEXT = "STUB-CONVENTION honored across the conversation";
const PRACTICE_NAME = "stub-practice";

function stubSetupSource(
  conventionText = CONVENTION_TEXT,
  practiceName = PRACTICE_NAME,
): SetupSource {
  return {
    resolve() {
      return {
        conventions: [{ scope: "project", text: conventionText }],
        practices: [{ name: practiceName, summary: "a stub practice" }],
      };
    },
  };
}

function noSetupSource(): SetupSource {
  return {
    resolve() {
      return undefined;
    },
  };
}

interface SnapshotRow {
  session_id: string;
  captured_at: string;
  practices: string;
  conventions: string;
}

function readSnapshot(store: Store, sessionId: string): SnapshotRow | null {
  return store.db
    .prepare("SELECT * FROM conversation_setup_snapshot WHERE session_id = ?")
    .get(sessionId) as SnapshotRow | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("assess with a resolved setup writes one snapshot row scoped to the conversation's asOf", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      setupSource: stubSetupSource(),
      runId: "run-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    const row = readSnapshot(store, SESSION);
    expect(row).not.toBeNull();
    expect(row!.captured_at).toBe(LATEST_EVENT_TIMESTAMP);
    expect(JSON.parse(row!.practices)).toEqual([{ name: PRACTICE_NAME }]);
    expect(JSON.parse(row!.conventions)).toEqual([
      { scope: "project", sha256: sha256(CONVENTION_TEXT) },
    ]);
  });
});

test("assess with no setup source injected writes no snapshot row", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      runId: "run-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(readSnapshot(store, SESSION)).toBeNull();
  });
});

test("a re-assess upserts the snapshot: the latest resolution wins, one row survives", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      setupSource: stubSetupSource(),
      runId: "run-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    const secondConventionText = "SECOND-CONVENTION, superseding the first";
    const secondPracticeName = "second-practice";
    await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      setupSource: stubSetupSource(secondConventionText, secondPracticeName),
      runId: "run-2",
      now: () => new Date("2026-06-15T13:00:00.000Z"),
    });

    const rowCount = (
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM conversation_setup_snapshot WHERE session_id = ?",
        )
        .get(SESSION) as { n: number }
    ).n;
    expect(rowCount).toBe(1);

    const row = readSnapshot(store, SESSION);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.practices)).toEqual([{ name: secondPracticeName }]);
    expect(JSON.parse(row!.conventions)).toEqual([
      { scope: "project", sha256: sha256(secondConventionText) },
    ]);
  });
});

test("assess with a setup source that resolves nothing writes no snapshot row", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      setupSource: noSetupSource(),
      runId: "run-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(readSnapshot(store, SESSION)).toBeNull();
  });
});

test("emitPrompt with a resolved setup writes the same snapshot the assess path writes", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    emitPrompt({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      setupSource: stubSetupSource(),
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    const row = readSnapshot(store, SESSION);
    expect(row).not.toBeNull();
    expect(row!.captured_at).toBe(LATEST_EVENT_TIMESTAMP);
    expect(JSON.parse(row!.practices)).toEqual([{ name: PRACTICE_NAME }]);
    expect(JSON.parse(row!.conventions)).toEqual([
      { scope: "project", sha256: sha256(CONVENTION_TEXT) },
    ]);
  });
});

test("recordVerdict never resolves setup, so it writes no snapshot row", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    const chunks = rolloutContent(TRANSCRIPT);
    const human = chunks.find((c) => c.kind === "human_prompt")!;
    const answer = chunks.find((c) => c.kind === "assistant_answer")!;

    const emitted = emitPrompt({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      setupSource: stubSetupSource(),
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    // A fresh store, mirroring a separate process recording the agent's
    // verdict with no setup source injected: the record half never resolves
    // setup, so a snapshot must not appear as a side effect of recording.
    const recordStore = openStore(":memory:");
    try {
      const result = recordVerdict({
        store: recordStore,
        harness: "codex",
        sessionsDir,
        sessionId: SESSION,
        envelope: {
          schemaVersion: emitted.schemaVersion,
          sessionId: SESSION,
          promptVersion: emitted.promptVersion,
          rubricVersion: emitted.rubricVersion,
          judgeModel: "agent",
          verdict: {
            intent: { value: "test-writing", anchors: [human.lineSeq] },
            assessment: {
              prose: "The engineer asked for a parser test; delivered.",
              anchors: [human.lineSeq, answer.lineSeq],
            },
            accomplishment: {
              value: "accomplished",
              anchors: [answer.lineSeq],
            },
          },
        },
        runId: "run-1",
        now: () => new Date("2026-06-15T12:05:00.000Z"),
      });

      expect(result.ok).toBe(true);
      expect(readSnapshot(recordStore, SESSION)).toBeNull();
    } finally {
      recordStore.close();
    }
  });
});
