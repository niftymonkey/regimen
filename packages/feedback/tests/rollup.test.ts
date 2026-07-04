/**
 * The verdict-rollup deterministic header, observed through rollupHeader.
 *
 * The header is the source of truth for ALL numbers in a rollup: the count of
 * judged conversations and a per-signal value distribution come straight from
 * SQL, never from the synthesis model. Each test seeds judged conversations (via
 * the writer) and conversation rows (inserted directly, as the loader would),
 * then asserts the counts the header reports. The seeding mirrors
 * judged-slice.test.ts, the template for this judged read layer. Pure SQLite
 * read: no Judge, no network.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStore, type Store } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult, JudgedSignal } from "../src/judged/types.ts";
import {
  collectVerdicts,
  rollupHeader,
  rollupVerdicts,
  ROLLUP_PROMPT_VERSION,
  synthesizeRollup,
  type RollupHeader,
  type SignalDistribution,
  type Verdict,
} from "../src/judged/rollup.ts";
import type {
  JudgeModelRequest,
  JudgeModelResponse,
} from "../src/judged/port.ts";

const ASSIGNMENT = "whole-conversation";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-rollup-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-rollup-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedConversation(db: Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
  ).run(sessionId, "2026-06-15T10:00:00.000Z", "2026-06-15T10:30:00.000Z");
}

function resultWith(signals: ReadonlyArray<JudgedSignal>): JudgeResult {
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
        prose: "The agent did the work.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

function signal(
  signalName: JudgedSignal["signalName"],
  value: string,
): JudgedSignal {
  const scope = signalName === "outcome" ? "assignment" : "conversation";
  return {
    scope,
    ...(scope === "assignment" ? { assignmentId: ASSIGNMENT } : {}),
    signalName,
    valueKind: signalName === "outcome" ? "ordinal" : "categorical",
    // The read layer groups raw stored strings; seeding the derived-spectrum
    // outcome values that the post-re-sweep writer stores needs a test-only cast.
    value: value as JudgedSignal["value"],
    anchors: [{ eventHash: "b".repeat(64) }],
  };
}

function judge(
  store: Store,
  sessionId: string,
  signals: ReadonlyArray<JudgedSignal>,
): void {
  const run: AssessmentRunIdentity = {
    runId: `run-${sessionId}`,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-06-15T10:00:00.000Z",
  };
  seedConversation(store.db, sessionId);
  writeAssessment(store, run, resultWith(signals));
}

function distributionFor(
  header: { distributions: ReadonlyArray<SignalDistribution> },
  signalName: string,
): SignalDistribution | undefined {
  return header.distributions.find((d) => d.signalName === signalName);
}

test("rollupHeader counts judged verdicts and excludes unjudged conversations", () => {
  withStore((store) => {
    judge(store, "a", [signal("outcome", "accomplished-cleanly")]);
    judge(store, "b", [signal("outcome", "partial")]);
    // An unjudged conversation must not count toward the rollup.
    seedConversation(store.db, "unjudged");

    expect(rollupHeader(store.db).totalJudged).toBe(2);
  });
});

test("rollupHeader returns a value distribution per signal, one bucket per value", () => {
  withStore((store) => {
    judge(store, "a", [
      signal("intent", "feature"),
      signal("engagement", "engaged"),
      signal("outcome", "accomplished-cleanly"),
    ]);
    judge(store, "b", [
      signal("intent", "bug-fix"),
      signal("engagement", "engaged"),
      signal("outcome", "partial"),
    ]);

    const header = rollupHeader(store.db);

    expect(distributionFor(header, "engagement")?.buckets).toEqual([
      { value: "engaged", count: 2 },
    ]);
    expect(distributionFor(header, "intent")?.buckets).toEqual([
      { value: "bug-fix", count: 1 },
      { value: "feature", count: 1 },
    ]);
  });
});

test("collectVerdicts returns one verdict per judged session, excluding the unjudged", () => {
  withStore((store) => {
    judge(store, "a", [
      signal("intent", "feature"),
      signal("outcome", "accomplished-cleanly"),
    ]);
    seedConversation(store.db, "unjudged");

    const verdicts = collectVerdicts(store.db);

    expect(verdicts).toEqual([
      {
        sessionId: "a",
        harness: "claude",
        model: "claude-opus-4-8",
        intent: "feature",
        outcome: "accomplished-cleanly",
        prose: "The agent did the work.",
      },
    ]);
  });
});

test("collectVerdicts leaves intent and outcome null when the run abstained on them", () => {
  withStore((store) => {
    judge(store, "a", [signal("engagement", "engaged")]);

    const [verdict] = collectVerdicts(store.db);

    expect(verdict?.intent).toBeNull();
    expect(verdict?.outcome).toBeNull();
    expect(verdict?.prose).toBe("The agent did the work.");
  });
});

function judgeAt(
  store: Store,
  sessionId: string,
  lastEventAt: string,
  signals: ReadonlyArray<JudgedSignal>,
): void {
  store.db
    .prepare(
      `INSERT INTO conversations
         (session_id, harness, model, first_event_at, last_event_at)
       VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
    )
    .run(sessionId, lastEventAt, lastEventAt);
  const run: AssessmentRunIdentity = {
    runId: `run-${sessionId}`,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: lastEventAt,
  };
  writeAssessment(store, run, resultWith(signals));
}

test("rollupHeader honors a since window, excluding an out-of-window judged conversation", () => {
  withStore((store) => {
    judgeAt(store, "recent", "2026-06-15T10:00:00.000Z", [
      signal("outcome", "accomplished-cleanly"),
    ]);
    judgeAt(store, "old", "2026-06-10T10:00:00.000Z", [
      signal("outcome", "partial"),
    ]);

    const header = rollupHeader(store.db, { since: "2026-06-12" });

    expect(header.totalJudged).toBe(1);
    expect(distributionFor(header, "outcome")?.buckets).toEqual([
      { value: "accomplished-cleanly", count: 1 },
    ]);
  });
});

test("rollupHeader orders the outcome distribution worst to best", () => {
  withStore((store) => {
    judge(store, "a", [signal("outcome", "accomplished-cleanly")]);
    judge(store, "b", [signal("outcome", "accomplished-cleanly")]);
    judge(store, "c", [signal("outcome", "partial")]);
    judge(store, "d", [signal("outcome", "not-accomplished")]);

    const outcome = distributionFor(rollupHeader(store.db), "outcome");

    expect(outcome?.buckets).toEqual([
      { value: "not-accomplished", count: 1 },
      { value: "partial", count: 1 },
      { value: "accomplished-cleanly", count: 2 },
    ]);
  });
});

/** A mock JudgeModelPort that records its request and returns fixed output. */
function capturingPort(text: string, model: string) {
  const calls: JudgeModelRequest[] = [];
  return {
    calls,
    port: {
      complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
        calls.push(request);
        return Promise.resolve({ text, model });
      },
    },
  };
}

const SAMPLE_HEADER: RollupHeader = {
  totalJudged: 3,
  distributions: [
    {
      signalName: "outcome",
      buckets: [
        { value: "partial", count: 1 },
        { value: "accomplished-cleanly", count: 2 },
      ],
    },
  ],
};

const SAMPLE_VERDICTS: ReadonlyArray<Verdict> = [
  {
    sessionId: "sess-alpha",
    harness: "claude",
    model: "claude-opus-4-8",
    intent: "refactor",
    outcome: "partial",
    prose:
      "The boundaries were never stated, so the first attempt overreached.",
  },
];

test("synthesizeRollup returns the model's prose and its provenance", async () => {
  const { port } = capturingPort("Pretty good week overall.", "some-model");

  const synthesis = await synthesizeRollup(
    { header: SAMPLE_HEADER, verdicts: SAMPLE_VERDICTS },
    { llm: port },
  );

  expect(synthesis.prose).toBe("Pretty good week overall.");
  expect(synthesis.judgeModel).toBe("some-model");
  expect(synthesis.promptVersion).toBe(ROLLUP_PROMPT_VERSION);
});

test("the synthesis prompt embeds the binding voice constraints", async () => {
  const { port, calls } = capturingPort("ok", "m");

  await synthesizeRollup(
    { header: SAMPLE_HEADER, verdicts: SAMPLE_VERDICTS },
    { llm: port },
  );

  const system = calls[0]!.system.toLowerCase();
  // The colleague voice, the neutral-subject/we-framed remedy rule, the
  // no-internal-vocabulary rule, the never-recompute-a-number rule, and the
  // no-dangling-threads follow-through, all load-bearing (voice-and-ux doc).
  expect(system).toContain("colleague");
  expect(system).toContain("my recommendation is that we");
  expect(system).toContain("zero internal vocabulary");
  expect(system).toContain("never recompute");
  expect(system).toContain("noted it");
});

test("the synthesis prompt passes the deterministic distributions and the session ids as facts", async () => {
  const { port, calls } = capturingPort("ok", "m");

  await synthesizeRollup(
    { header: SAMPLE_HEADER, verdicts: SAMPLE_VERDICTS },
    { llm: port },
  );

  const user = calls[0]!.user;
  // The header counts arrive as given facts the model must not recompute.
  expect(user).toContain("judged conversations: 3");
  expect(user).toContain("accomplished-cleanly=2");
  expect(user).toContain("partial=1");
  // Each verdict carries its session id so a narrative claim traces back.
  expect(user).toContain("sess-alpha");
  expect(user).toContain("boundaries were never stated");
});

const FIXED_NOW = (): number => Date.parse("2026-06-20T00:00:00.000Z");

test("rollupVerdicts composes the deterministic header with the synthesized narrative", async () => {
  await withStoreAsync(async (store) => {
    judge(store, "a", [signal("outcome", "accomplished-cleanly")]);
    judge(store, "b", [signal("outcome", "partial")]);
    const { port } = capturingPort("The week went fine.", "judge-x");

    const rollup = await rollupVerdicts(store.db, {
      llm: port,
      now: FIXED_NOW,
    });

    expect(rollup.schemaVersion).toBe(1);
    expect(rollup.generatedAt).toBe("2026-06-20T00:00:00.000Z");
    expect(rollup.header.totalJudged).toBe(2);
    expect(rollup.synthesis?.prose).toBe("The week went fine.");
    expect(rollup.synthesis?.judgeModel).toBe("judge-x");
    expect(rollup.filter).toEqual({});
  });
});

test("rollupVerdicts over an empty corpus returns synthesis null and never calls the model", async () => {
  await withStoreAsync(async (store) => {
    // A port that throws if reached: a passing empty-corpus rollup proves the
    // short-circuit returns before any model call, so a zero-judged rollup is free.
    const throwingPort = {
      complete(): Promise<never> {
        throw new Error("the model must not be called over an empty corpus");
      },
    };
    seedConversation(store.db, "unjudged");

    const rollup = await rollupVerdicts(store.db, {
      llm: throwingPort,
      now: FIXED_NOW,
    });

    expect(rollup.header.totalJudged).toBe(0);
    expect(rollup.synthesis).toBeNull();
  });
});
