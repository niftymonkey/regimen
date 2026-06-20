/**
 * The Judge (judgeConversation) behavior, S3 spec section 2. Every test injects
 * a deterministic stub JudgeModelPort and makes zero network calls. The tests
 * pin the depth of the module: happy-path parsing and anchor resolution,
 * reasoning-before-Outcome, closed-vocabulary enforcement, anchor membership
 * validation, bounded retry, and fail-closed assembly.
 */
import { expect, test } from "bun:test";
import type {
  AnchorRef,
  ContentChunk,
} from "../src/loader/rollout/codex-reader.ts";
import type {
  JudgeModelPort,
  JudgeModelRequest,
  JudgeModelResponse,
} from "../src/judged/port.ts";
import { judgeConversation } from "../src/judged/judge.ts";

const SESSION = "019e0000-1111-7000-8000-00000000aaaa";

function chunk(
  lineSeq: number,
  kind: ContentChunk["kind"],
  text: string,
  anchor: AnchorRef,
): ContentChunk {
  return { kind, text, anchor, lineSeq };
}

/** A small two-chunk conversation: one human prompt, one assistant answer. */
const CHUNKS: ContentChunk[] = [
  chunk(0, "human_prompt", "add a test for the parser", {
    eventHash: "a".repeat(64),
  }),
  chunk(1, "assistant_answer", "Done, the parser test passes.", {
    eventHash: "b".repeat(64),
  }),
];

/**
 * A stub port that returns a fixed text and model, and records the last request
 * so a test can assert on the prompt the Judge built.
 */
function stubPort(
  text: string,
  model = "claude-opus-4-8",
): JudgeModelPort & { lastRequest: () => JudgeModelRequest | undefined } {
  let last: JudgeModelRequest | undefined;
  return {
    complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
      last = request;
      return Promise.resolve({ text, model });
    },
    lastRequest: () => last,
  };
}

/** A well-formed verdict citing chunk ids 0 and 1, prose before Outcome. */
const WELL_FORMED = JSON.stringify({
  intent: { value: "test-writing", anchors: [0] },
  assessment: {
    prose: "The engineer asked for a parser test; the agent delivered it.",
    anchors: [0, 1],
  },
  outcome: { value: "accomplished-cleanly", anchors: [1] },
});

test("a well-formed verdict parses to Intent, Outcome, and the assessment with provenance from response.model", async () => {
  const port = stubPort(WELL_FORMED, "claude-opus-4-8");
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, rubricVersion: "2026-06-15", promptVersion: "2026-06-15" },
  );

  expect(result.complete).toBe(true);
  expect(result.incompleteReason).toBeUndefined();
  expect(result.provenance.judgeModel).toBe("claude-opus-4-8");
  expect(result.provenance.rubricVersion).toBe("2026-06-15");
  expect(result.provenance.promptVersion).toBe("2026-06-15");

  const intent = result.signals.find((s) => s.signalName === "intent");
  expect(intent!.value).toBe("test-writing");
  expect(intent!.valueKind).toBe("categorical");
  // The cited chunk id 0 maps back to the real AnchorRef of chunk 0.
  expect(intent!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);

  const outcome = result.signals.find((s) => s.signalName === "outcome");
  expect(outcome!.value).toBe("accomplished-cleanly");
  expect(outcome!.valueKind).toBe("ordinal");
  expect(outcome!.anchors).toEqual([{ eventHash: "b".repeat(64) }]);

  expect(result.narratives.length).toBe(1);
  expect(result.narratives[0]!.narrativeType).toBe("assessment");
  expect(result.narratives[0]!.prose).toContain("parser test");
  expect(result.narratives[0]!.anchors).toEqual([
    { eventHash: "a".repeat(64) },
    { eventHash: "b".repeat(64) },
  ]);
});

test("the prompt the Judge builds enumerates each chunk with its citable id and the closed vocabularies", async () => {
  const port = stubPort(WELL_FORMED);
  await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port },
  );
  const request = port.lastRequest();
  expect(request).toBeDefined();
  // Each chunk is presented with its citable id and its text.
  expect(request!.user).toContain("[0]");
  expect(request!.user).toContain("add a test for the parser");
  expect(request!.user).toContain("[1]");
  expect(request!.user).toContain("Done, the parser test passes.");
  // The closed vocabularies and the prose-before-Outcome rule are pinned.
  expect(request!.system).toContain("test-writing");
  expect(request!.system).toContain("accomplished-cleanly");
  expect(request!.system).toContain("BEFORE");
  // Software quality and transcript length are explicit non-goals.
  expect(request!.system).toContain("software quality");
});

test("an out-of-vocab Intent is rejected, not coerced to other; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "documentation", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    outcome: { value: "accomplished-cleanly", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const intent = result.signals.find((s) => s.signalName === "intent");
  expect(intent).toBeUndefined();
  // The Outcome still validates, so it is present (absence is per-signal).
  expect(result.signals.find((s) => s.signalName === "outcome")).toBeDefined();
});

test("an Outcome outside the four ranked values is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    outcome: { value: "great-success", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "outcome"),
  ).toBeUndefined();
  expect(result.signals.find((s) => s.signalName === "intent")).toBeDefined();
});

test("a cited anchor not in the chunk set is dropped; a claim left with zero anchors abstains", async () => {
  const text = JSON.stringify({
    // Intent cites id 0 (valid) and id 99 (not in the set): id 0 survives.
    intent: { value: "test-writing", anchors: [99, 0] },
    assessment: { prose: "ok", anchors: [0] },
    // Outcome cites only id 99 (not in the set): zero resolvable anchors -> absent.
    outcome: { value: "accomplished-cleanly", anchors: [99] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const intent = result.signals.find((s) => s.signalName === "intent");
  expect(intent!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
  expect(
    result.signals.find((s) => s.signalName === "outcome"),
  ).toBeUndefined();
});

/**
 * A scripted port that returns a different text on each call, so a test can
 * drive the retry loop (first call malformed, second well-formed).
 */
function scriptedPort(
  texts: string[],
  model = "claude-opus-4-8",
): JudgeModelPort & { calls: () => number } {
  let i = 0;
  return {
    complete(): Promise<JudgeModelResponse> {
      const text = texts[Math.min(i, texts.length - 1)]!;
      i += 1;
      return Promise.resolve({ text, model });
    },
    calls: () => i,
  };
}

test("malformed output drives a bounded retry that recovers on a later attempt", async () => {
  const port = scriptedPort(["not json at all", WELL_FORMED]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  // The first call was unparseable; the retry recovered a complete verdict.
  expect(port.calls()).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.signals.length).toBe(2);
});

test("retry exhaustion on malformed output yields complete=false with llm-unparseable", async () => {
  const port = scriptedPort(["garbage"]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  // One initial call plus two repairs, all garbage.
  expect(port.calls()).toBe(3);
  expect(result.complete).toBe(false);
  expect(result.incompleteReason).toBe("llm-unparseable");
  expect(result.signals.length).toBe(0);
});

test("a thrown port yields complete=false with llm-unavailable", async () => {
  const failing: JudgeModelPort = {
    complete(): Promise<JudgeModelResponse> {
      return Promise.reject(new Error("network down"));
    },
  };
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: failing },
  );
  expect(result.complete).toBe(false);
  expect(result.incompleteReason).toBe("llm-unavailable");
  expect(result.signals.length).toBe(0);
});

test("reasoning before Outcome is enforced: an Outcome with no assessment is not constructed", async () => {
  // A verdict with a valid Outcome but no assessment prose: invalid by the
  // prose-before-Outcome rule, so it drives the retry and then abstains.
  const noAssessment = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    outcome: { value: "accomplished-cleanly", anchors: [1] },
  });
  const port = scriptedPort([noAssessment]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 1 },
  );
  expect(result.complete).toBe(false);
  expect(result.incompleteReason).toBe("llm-unparseable");
  // No Outcome is constructed when the required assessment is absent.
  expect(
    result.signals.find((s) => s.signalName === "outcome"),
  ).toBeUndefined();
});

test("a parseable verdict that grounds no signal is an insufficient-evidence run", async () => {
  // Well-formed JSON, but every claim abstains (no value, only an assessment).
  const thin = JSON.stringify({
    intent: { anchors: [0] },
    assessment: {
      prose: "Too little happened to judge intent or outcome.",
      anchors: [0],
    },
    outcome: { anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(thin) },
  );
  expect(result.complete).toBe(false);
  expect(result.incompleteReason).toBe("insufficient-evidence");
  expect(result.signals.length).toBe(0);
  // The honest narrative may still stand when the judge can say something.
  expect(result.narratives.length).toBe(1);
});

test("omitting config.llm resolves the default Anthropic adapter (no network here)", async () => {
  // When config.llm is omitted, judgeConversation resolves the production
  // adapter via resolveDefaultJudgeModel (spec section 3). With no key in env,
  // that resolution throws the adapter's env error rather than the old
  // placeholder throw, proving the default seam is wired. No network is made:
  // the adapter is never invoked because construction fails first.
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await expect(
      judgeConversation({ sessionId: SESSION, chunks: CHUNKS }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
