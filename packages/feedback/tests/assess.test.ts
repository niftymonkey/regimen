/**
 * The assess orchestrator (assessConversation) end to end, S3 spec section 1.
 * The acceptance surface: it runs against a temp sessions dir and a :memory:
 * store with a stub JudgeModelPort, so the whole orchestration is deterministic
 * with no network. The tests pin the load-bearing anchor insertion, the single
 * verdict write, re-judge supersede, and the fail-closed branches.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import { rolloutContent } from "../src/loader/rollout/codex-reader.ts";
import { assessConversation } from "../src/judged/assess.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real Codex rollout: meta, a human prompt, an assistant answer. */
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

/** Write the transcript as the (only, hence newest/open) rollout file. */
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
  const root = mkdtempSync(join(tmpdir(), "regimen-assess-"));
  const store = openStore(":memory:");
  const sessionsDir = join(root, "sessions");
  return fn({ store, sessionsDir }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

/**
 * A stub Judge model that cites the transcript's chunk ids. It derives the
 * citable ids from the content projection so the verdict's anchors are exactly
 * those the orchestrator inserted, the way a real judge would after reading the
 * enumerated prompt.
 */
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
    outcome: { value: "accomplished-cleanly", anchors: [answer.lineSeq] },
  });
  return {
    complete(): Promise<JudgeModelResponse> {
      return Promise.resolve({ text: verdict, model: "claude-opus-4-8" });
    },
  };
}

/** A second well-formed verdict the stub returns on a re-judge. */
function rejudgeStub(content: string): JudgeModelPort {
  const chunks = rolloutContent(content);
  const human = chunks.find((c) => c.kind === "human_prompt")!;
  const answer = chunks.find((c) => c.kind === "assistant_answer")!;
  const verdict = JSON.stringify({
    intent: { value: "feature", anchors: [human.lineSeq] },
    assessment: {
      prose: "On a second look, the engineer was adding a feature.",
      anchors: [human.lineSeq, answer.lineSeq],
    },
    outcome: { value: "partial", anchors: [answer.lineSeq] },
  });
  return {
    complete(): Promise<JudgeModelResponse> {
      return Promise.resolve({ text: verdict, model: "claude-opus-4-8" });
    },
  };
}

test("a full assess pass writes one run, the assignment, signals, narrative, and inserts the events", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    const digest = await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      runId: "run-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    expect(digest.judged).toBe(true);

    const runCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;
    expect(runCount).toBe(1);

    const signalCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM judged_signal").get() as {
        n: number;
      }
    ).n;
    expect(signalCount).toBe(2);

    // The load-bearing anchor insertion: the reader's structural events are in
    // the store, so a {eventHash} anchor in the verdict resolves to a real row.
    if (digest.judged !== true) throw new Error("expected judged");
    const anchor = digest.assessment!.anchors[0];
    expect(anchor).toBeDefined();
    if (anchor !== undefined && "eventHash" in anchor) {
      const row = store.db
        .prepare(
          "SELECT 1 FROM events WHERE lower(hex(event_hash)) = ? LIMIT 1",
        )
        .get(anchor.eventHash);
      expect(row).not.toBeNull();
    } else {
      throw new Error("expected an eventHash anchor");
    }
  });
});

test("a re-judge supersedes the prior run: one run's signals win, no duplicates", async () => {
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
    const second = await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: rejudgeStub(TRANSCRIPT),
      runId: "run-2",
      now: () => new Date("2026-06-15T13:00:00.000Z"),
    });

    if (second.judged !== true) throw new Error("expected judged");

    // Two run rows accumulate (provenance history), but the signals are the
    // latest run's only: no duplicates.
    const runCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;
    expect(runCount).toBe(2);

    const signalRunIds = (
      store.db.prepare("SELECT DISTINCT run_id FROM judged_signal").all() as {
        run_id: string;
      }[]
    ).map((r) => r.run_id);
    expect(signalRunIds).toEqual(["run-2"]);

    const signalCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM judged_signal").get() as {
        n: number;
      }
    ).n;
    expect(signalCount).toBe(2);

    // The latest verdict's values win.
    expect(second.outcome!.value).toBe("partial");

    // The conversation-scope assessment narrative supersedes too: exactly one
    // narrative row survives, the latest run's. It is stored under the
    // empty-string assignment_id sentinel (absent assignment id, ADR-0008); a
    // NULL would not enforce PK uniqueness, so a re-judge would accumulate a
    // second narrative row.
    const narrativeRows = store.db
      .prepare("SELECT run_id FROM narrative")
      .all() as { run_id: string }[];
    expect(narrativeRows.length).toBe(1);
    expect(narrativeRows[0]!.run_id).toBe("run-2");
  });
});

test("a missing transcript throws a clear error and writes nothing", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    // No rollout seeded: the locator finds nothing for this session.
    mkdirSync(sessionsDir, { recursive: true });
    await expect(
      assessConversation({
        store,
        harness: "codex",
        sessionsDir,
        sessionId: SESSION,
        llm: stubJudgeModel(TRANSCRIPT),
        runId: "run-1",
        now: () => new Date("2026-06-15T12:00:00.000Z"),
      }),
    ).rejects.toThrow(SESSION);

    const runCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;
    expect(runCount).toBe(0);
    const eventCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(eventCount).toBe(0);
  });
});

test("a valid-but-unregistered harness fails closed and writes nothing", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    seedRollout(sessionsDir);
    await expect(
      assessConversation({
        store,
        harness: "cursor",
        sessionsDir,
        sessionId: SESSION,
        llm: stubJudgeModel(TRANSCRIPT),
        runId: "run-1",
        now: () => new Date("2026-06-15T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/unsupported harness: cursor/);

    const runCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;
    expect(runCount).toBe(0);
    const eventCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(eventCount).toBe(0);
  });
});

test("an empty transcript is an insufficient-evidence run with the signal absent", async () => {
  await withHarness(async ({ store, sessionsDir }) => {
    // A transcript with only session_meta yields zero content chunks.
    const onlyMeta = line({
      timestamp: "2026-06-15T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: SESSION,
        cwd: "/work/p",
        originator: "codex_exec",
        source: "exec",
      },
    });
    seedRollout(sessionsDir, onlyMeta);

    const digest = await assessConversation({
      store,
      harness: "codex",
      sessionsDir,
      sessionId: SESSION,
      llm: stubJudgeModel(TRANSCRIPT),
      runId: "run-1",
      now: () => new Date("2026-06-15T12:00:00.000Z"),
    });

    // The run is honestly incomplete with no fabricated signal.
    if (digest.judged !== true) throw new Error("expected judged branch");
    expect(digest.complete).toBe(false);
    const signalCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM judged_signal").get() as {
        n: number;
      }
    ).n;
    expect(signalCount).toBe(0);
  });
});
