/**
 * assess end to end for the Gemini harness: harness:"gemini" selects the Gemini
 * reader/resolver through the registry, locates a real-shape Gemini
 * `chats/session-*.jsonl` by reading its init-line sessionId, reads it, inserts
 * its events, and writes a judged verdict whose anchors resolve. This is the
 * end-to-end proof that the Gemini leg plugs into the same orchestrator the
 * Codex, Claude, and Copilot legs use, with no harness named in assess.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import { geminiRead } from "../src/loader/rollout/gemini-reader.ts";
import { assessConversation } from "../src/judged/assess.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";

const SESSION = "bbddfdf7-482c-4b2d-bbfb-c9ba0982f534";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real-shape Gemini transcript: init, snapshot, prompt, answer. */
const TRANSCRIPT = [
  line({
    sessionId: SESSION,
    projectHash: "ph",
    startTime: "2026-06-15T10:00:00.000Z",
    lastUpdated: "2026-06-15T10:00:00.000Z",
    kind: "main",
  }),
  line({
    $set: {
      messages: [
        {
          id: "d04923d38bb0f6017037e74183378ef4",
          timestamp: "2026-06-15T10:00:00.000Z",
          type: "user",
          content: [{ text: "<session_context>\nsetup\n</session_context>" }],
        },
      ],
      lastUpdated: "2026-06-15T10:00:00.000Z",
    },
  }),
  line({
    id: "c9677e0c-c6b0-4fce-913a-ad01c9d0de44",
    timestamp: "2026-06-15T10:00:01.000Z",
    type: "user",
    content: [{ text: "add a test for the parser" }],
  }),
  line({
    id: "424b570c-8af7-4362-b336-cb3581b0507c",
    timestamp: "2026-06-15T10:00:02.000Z",
    type: "gemini",
    content: "Done, the parser test passes.",
    thoughts: [{ subject: "x", description: "SECRET", timestamp: "x" }],
    model: "gemini-3.5-flash",
  }),
].join("\n");

interface Harness {
  store: Store;
  sessionsDir: string;
}

function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "regimen-assess-gemini-"));
  const store = openStore(":memory:");
  const sessionsDir = join(root, "tmp");
  return fn({ store, sessionsDir }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

/** Write the transcript under an alias's chats dir as the only transcript. */
function seedTranscript(sessionsDir: string, content = TRANSCRIPT): void {
  const dir = join(sessionsDir, "dev", "chats");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-2026-06-15T10-00-bbddfdf7.jsonl"), content);
}

/** A stub Judge that cites the Gemini transcript's projected chunk ids. */
function stubJudgeModel(content: string): JudgeModelPort {
  const chunks = geminiRead(content, { complete: false }).content;
  const human = chunks.find(
    (c) => c.kind === "human_prompt" && c.text === "add a test for the parser",
  )!;
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
      return Promise.resolve({ text: verdict, model: "gemini-3.5-flash" });
    },
  };
}

test("assess with harness gemini reads the filesystem-located transcript and writes a judged verdict", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedTranscript(sessionsDir);
    const digest = await assessConversation({
      store,
      harness: "gemini",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      runId: "run-gemini-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(digest.judged).toBe(true);

    // The Gemini reader's structural events were inserted (the anchor step), so
    // the harness column on a stored event is gemini, proving the Gemini reader
    // (not another reader) produced them.
    const harnessRow = store.db
      .prepare("SELECT DISTINCT harness FROM events")
      .all() as Array<{ harness: string }>;
    expect(harnessRow.map((r) => r.harness)).toEqual(["gemini"]);
  });
});

test("assess fails closed when the gemini session has no transcript in the tmp tree", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    mkdirSync(sessionsDir, { recursive: true });
    await expect(
      assessConversation({
        store,
        harness: "gemini",
        sessionsDir,
        sessionId: "no-such-session",
        llm: stubJudgeModel(TRANSCRIPT),
      }),
    ).rejects.toThrow(/no rollout transcript found/);
  });
});
