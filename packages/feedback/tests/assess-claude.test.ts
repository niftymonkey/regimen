/**
 * assess end to end for the Claude harness: harness:"claude" selects the Claude
 * reader/resolver through the registry, reads a real-shape Claude transcript from
 * the projects tree, inserts its events, and writes a judged verdict whose
 * anchors resolve. This is the end-to-end proof that the Claude leg plugs into
 * the same orchestrator the Codex leg uses, with no harness named in assess.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import { claudeRead } from "../src/loader/rollout/claude-reader.ts";
import { assessConversation } from "../src/judged/assess.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";

const SESSION = "08551ace-1f3c-40b2-a088-ef00ce37027f";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real-shape Claude transcript: a prompt and an assistant answer. */
const TRANSCRIPT = [
  line({
    type: "user",
    cwd: "/work/p",
    isSidechain: false,
    message: { role: "user", content: "add a test for the parser" },
    sessionId: SESSION,
    timestamp: "2026-06-15T10:00:01.000Z",
    uuid: "u-1",
  }),
  line({
    type: "assistant",
    cwd: "/work/p",
    isSidechain: false,
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "Done, the parser test passes." }],
    },
    sessionId: SESSION,
    timestamp: "2026-06-15T10:00:02.000Z",
    uuid: "u-2",
  }),
].join("\n");

interface Harness {
  store: Store;
  projectsDir: string;
}

function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "regimen-assess-claude-"));
  const store = openStore(":memory:");
  const projectsDir = join(root, "projects");
  return fn({ store, projectsDir }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

/** Write the transcript under its project slug as the only (newest) transcript. */
function seedTranscript(projectsDir: string, content = TRANSCRIPT): void {
  const dir = join(projectsDir, "-work-p");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), content);
}

/** A stub Judge that cites the Claude transcript's projected chunk ids. */
function stubJudgeModel(content: string): JudgeModelPort {
  const chunks = claudeRead(content, { complete: false }).content;
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
      return Promise.resolve({ text: verdict, model: "claude-opus-4-8" });
    },
  };
}

test("assess with harness claude reads the projects-tree transcript and writes a judged verdict", async () => {
  await withHarness(async ({ store, projectsDir }) => {
    seedTranscript(projectsDir);
    const digest = await assessConversation({
      store,
      harness: "claude",
      sessionsDir: projectsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      runId: "run-claude-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(digest.judged).toBe(true);

    // The Claude reader's structural events were inserted (the anchor step), so
    // the harness column on a stored event is claude, proving the Claude reader
    // (not the Codex reader) produced them.
    const harnessRow = store.db
      .prepare("SELECT DISTINCT harness FROM events")
      .all() as Array<{ harness: string }>;
    expect(harnessRow.map((r) => r.harness)).toEqual(["claude"]);
  });
});

test("assess fails closed when the claude session has no transcript in the projects tree", async () => {
  await withHarness(async ({ store, projectsDir }) => {
    mkdirSync(projectsDir, { recursive: true });
    await expect(
      assessConversation({
        store,
        harness: "claude",
        sessionsDir: projectsDir,
        sessionId: "no-such-session",
        llm: stubJudgeModel(TRANSCRIPT),
      }),
    ).rejects.toThrow(/no rollout transcript found/);
  });
});
