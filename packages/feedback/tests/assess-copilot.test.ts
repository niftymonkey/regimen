/**
 * assess end to end for the Copilot harness: harness:"copilot" selects the
 * Copilot reader/resolver through the registry, reads a real-shape Copilot
 * `events.jsonl` from the session-state tree, inserts its events, and writes a
 * judged verdict whose anchors resolve. This is the end-to-end proof that the
 * Copilot leg plugs into the same orchestrator the Codex and Claude legs use,
 * with no harness named in assess.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import { copilotRead } from "../src/loader/rollout/copilot-reader.ts";
import { assessConversation } from "../src/judged/assess.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";

const SESSION = "e2ba254f-5455-47e2-aa80-1bc2706d7294";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real-shape Copilot transcript: a prompt and an assistant answer. */
const TRANSCRIPT = [
  line({
    type: "session.start",
    data: { sessionId: SESSION, context: { cwd: "/work/p" } },
    id: "evt-start",
    timestamp: "2026-06-15T10:00:00.000Z",
    parentId: null,
  }),
  line({
    type: "user.message",
    data: { content: "add a test for the parser" },
    id: "evt-user",
    timestamp: "2026-06-15T10:00:01.000Z",
    parentId: "evt-start",
  }),
  line({
    type: "assistant.message",
    data: {
      content: "Done, the parser test passes.",
      model: "gpt-5-mini",
      reasoningOpaque: "SECRET",
      encryptedContent: "SECRET",
      toolRequests: [],
    },
    id: "evt-answer",
    timestamp: "2026-06-15T10:00:02.000Z",
    parentId: "evt-user",
  }),
].join("\n");

interface Harness {
  store: Store;
  sessionsDir: string;
}

function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "regimen-assess-copilot-"));
  const store = openStore(":memory:");
  const sessionsDir = join(root, "session-state");
  return fn({ store, sessionsDir }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

/** Write the transcript under its session id as the only (newest) transcript. */
function seedTranscript(sessionsDir: string, content = TRANSCRIPT): void {
  const dir = join(sessionsDir, SESSION);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), content);
}

/** A stub Judge that cites the Copilot transcript's projected chunk ids. */
function stubJudgeModel(content: string): JudgeModelPort {
  const chunks = copilotRead(content, { complete: false }).content;
  const human = chunks.find((c) => c.kind === "human_prompt")!;
  const answer = chunks.find((c) => c.kind === "assistant_answer")!;
  const verdict = JSON.stringify({
    intent: { value: "test-writing", anchors: [human.lineSeq] },
    assessment: {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [human.lineSeq, answer.lineSeq],
    },
    outcome: { value: "accomplished-cleanly", anchors: [answer.lineSeq] },
  });
  return {
    complete(): Promise<JudgeModelResponse> {
      return Promise.resolve({ text: verdict, model: "gpt-5-mini" });
    },
  };
}

test("assess with harness copilot reads the session-state transcript and writes a judged verdict", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedTranscript(sessionsDir);
    const digest = await assessConversation({
      store,
      harness: "copilot",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      runId: "run-copilot-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(digest.judged).toBe(true);

    // The Copilot reader's structural events were inserted (the anchor step), so
    // the harness column on a stored event is copilot, proving the Copilot
    // reader (not another reader) produced them.
    const harnessRow = store.db
      .prepare("SELECT DISTINCT harness FROM events")
      .all() as Array<{ harness: string }>;
    expect(harnessRow.map((r) => r.harness)).toEqual(["copilot"]);
  });
});

test("assess fails closed when the copilot session has no transcript in the session-state tree", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    mkdirSync(sessionsDir, { recursive: true });
    await expect(
      assessConversation({
        store,
        harness: "copilot",
        sessionsDir,
        sessionId: "no-such-session",
        llm: stubJudgeModel(TRANSCRIPT),
      }),
    ).rejects.toThrow(/no rollout transcript found/);
  });
});
