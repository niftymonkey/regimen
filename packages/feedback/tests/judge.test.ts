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

/**
 * A well-formed verdict citing chunk ids 0 and 1, prose before the labels. It
 * carries the accomplishment axis (accomplished) but omits correction-cost, so
 * the signal count stays at two (intent + accomplishment); correction-cost is
 * exercised in its own test.
 */
const WELL_FORMED = JSON.stringify({
  intent: { value: "test-writing", anchors: [0] },
  assessment: {
    prose: "The engineer asked for a parser test; the agent delivered it.",
    anchors: [0, 1],
  },
  accomplishment: { value: "accomplished", anchors: [1] },
});

test("a well-formed verdict parses to Intent, accomplishment, and the assessment with provenance from response.model", async () => {
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

  const accomplishment = result.signals.find(
    (s) => s.signalName === "accomplishment",
  );
  expect(accomplishment!.value).toBe("accomplished");
  expect(accomplishment!.valueKind).toBe("ordinal");
  expect(accomplishment!.scope).toBe("assignment");
  expect(accomplishment!.anchors).toEqual([{ eventHash: "b".repeat(64) }]);

  expect(result.narratives.length).toBe(1);
  expect(result.narratives[0]!.narrativeType).toBe("assessment");
  expect(result.narratives[0]!.prose).toContain("parser test");
  expect(result.narratives[0]!.anchors).toEqual([
    { eventHash: "a".repeat(64) },
    { eventHash: "b".repeat(64) },
  ]);
});

/**
 * A well-formed verdict that also carries the engagement signal, citing chunk
 * id 0. Kept separate from WELL_FORMED so the existing signals.length pins stay
 * at two; engagement adds a third signal only in its own tests.
 */
const WITH_ENGAGEMENT = JSON.stringify({
  intent: { value: "test-writing", anchors: [0] },
  assessment: {
    prose: "The engineer asked for a parser test; the agent delivered it.",
    anchors: [0, 1],
  },
  accomplishment: { value: "accomplished", anchors: [1] },
  engagement: { value: "engaged", anchors: [0] },
});

/** A well-formed accomplished verdict that also carries the correction-cost axis. */
const WITH_CORRECTION_COST = JSON.stringify({
  intent: { value: "test-writing", anchors: [0] },
  assessment: {
    prose: "The engineer asked for a parser test; the agent delivered it.",
    anchors: [0, 1],
  },
  accomplishment: { value: "accomplished", anchors: [1] },
  "correction-cost": { value: "light", anchors: [0] },
});

test("a well-formed verdict yields a correction-cost signal (ordinal, assignment-scoped)", async () => {
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(WITH_CORRECTION_COST) },
  );
  const cost = result.signals.find((s) => s.signalName === "correction-cost");
  expect(cost).toBeDefined();
  expect(cost!.value).toBe("light");
  expect(cost!.valueKind).toBe("ordinal");
  expect(cost!.scope).toBe("assignment");
  expect(cost!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
});

test("an out-of-vocab correction-cost value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    "correction-cost": { value: "some", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "correction-cost"),
  ).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("a well-formed verdict yields an engagement signal (categorical, conversation-scoped)", async () => {
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(WITH_ENGAGEMENT) },
  );
  const engagement = result.signals.find((s) => s.signalName === "engagement");
  expect(engagement).toBeDefined();
  expect(engagement!.value).toBe("engaged");
  expect(engagement!.valueKind).toBe("categorical");
  expect(engagement!.scope).toBe("conversation");
  // The cited chunk id 0 maps back to the real AnchorRef of chunk 0.
  expect(engagement!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
});

test("a well-formed verdict yields a verification signal (categorical, conversation-scoped)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    verification: { value: "accepted-unverified", anchors: [0, 1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const verification = result.signals.find(
    (s) => s.signalName === "verification",
  );
  expect(verification).toBeDefined();
  expect(verification!.value).toBe("accepted-unverified");
  expect(verification!.valueKind).toBe("categorical");
  expect(verification!.scope).toBe("conversation");
  expect(verification!.anchors).toEqual([
    { eventHash: "a".repeat(64) },
    { eventHash: "b".repeat(64) },
  ]);
});

test("an out-of-vocab verification value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    verification: { value: "double-checked", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "verification"),
  ).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("a well-formed verdict yields a framing signal (ordinal, conversation-scoped)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    framing: { value: "clear", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const framing = result.signals.find((s) => s.signalName === "framing");
  expect(framing).toBeDefined();
  expect(framing!.value).toBe("clear");
  expect(framing!.valueKind).toBe("ordinal");
  expect(framing!.scope).toBe("conversation");
  expect(framing!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
});

test("an out-of-vocab framing value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    framing: { value: "vague", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "framing"),
  ).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("a well-formed verdict yields a conducting signal (ordinal, conversation-scoped)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    conducting: { value: "well-conducted", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const conducting = result.signals.find((s) => s.signalName === "conducting");
  expect(conducting).toBeDefined();
  expect(conducting!.value).toBe("well-conducted");
  expect(conducting!.valueKind).toBe("ordinal");
  expect(conducting!.scope).toBe("conversation");
  expect(conducting!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
});

test("an out-of-vocab conducting value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    conducting: { value: "chaotic", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "conducting"),
  ).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("a well-formed verdict yields an effort signal (ordinal, conversation-scoped)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    effort: { value: "high", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const effort = result.signals.find((s) => s.signalName === "effort");
  expect(effort).toBeDefined();
  expect(effort!.value).toBe("high");
  expect(effort!.valueKind).toBe("ordinal");
  expect(effort!.scope).toBe("conversation");
  expect(effort!.anchors).toEqual([{ eventHash: "b".repeat(64) }]);
});

test("an out-of-vocab effort value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    effort: { value: "extreme", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(result.signals.find((s) => s.signalName === "effort")).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("a well-formed shortfall verdict yields an attribution signal (categorical, conversation-scoped)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "partial", anchors: [1] },
    attribution: { value: "framing", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const attribution = result.signals.find(
    (s) => s.signalName === "attribution",
  );
  expect(attribution).toBeDefined();
  expect(attribution!.value).toBe("framing");
  expect(attribution!.valueKind).toBe("categorical");
  expect(attribution!.scope).toBe("conversation");
  expect(attribution!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
});

test("attribution is dropped when the verdict is not a shortfall (accomplished, no poor process signal)", async () => {
  // Attribution is the on-shortfall diagnostic (ADR-0017): a clean success must
  // not persist a routing target, so the parser drops it with no write.
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    attribution: { value: "framing", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "attribution"),
  ).toBeUndefined();
  // The clean-success signals are unaffected (the gate is attribution-only).
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("attribution is kept on a verification-only shortfall (accomplished but accepted-unverified)", async () => {
  // Shortfall is broader than done-ness (ADR-0017): a live-arc quality signal at
  // its poor floor is a shortfall too, so an accomplished session whose
  // verification is accepted-unverified still carries a routing target.
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    verification: { value: "accepted-unverified", anchors: [0, 1] },
    attribution: { value: "verification", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const attribution = result.signals.find(
    (s) => s.signalName === "attribution",
  );
  expect(attribution).toBeDefined();
  expect(attribution!.value).toBe("verification");
});

test("a well-formed verdict yields a convention-adherence signal (categorical, conversation-scoped)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    "convention-adherence": { value: "followed", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const adherence = result.signals.find(
    (s) => s.signalName === "convention-adherence",
  );
  expect(adherence).toBeDefined();
  expect(adherence!.value).toBe("followed");
  expect(adherence!.valueKind).toBe("categorical");
  expect(adherence!.scope).toBe("conversation");
  expect(adherence!.anchors).toEqual([{ eventHash: "b".repeat(64) }]);
});

test("an out-of-vocab convention-adherence value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    "convention-adherence": { value: "ignored", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "convention-adherence"),
  ).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("convention-adherence abstains when the verdict omits it (no conventions in force)", async () => {
  // Always-on but abstain-when-none-in-force (ADR-0017): a verdict that omits the
  // key produces no row, never a fabricated not-applicable value.
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(WELL_FORMED) },
  );
  expect(
    result.signals.find((s) => s.signalName === "convention-adherence"),
  ).toBeUndefined();
});

test("attribution is kept on a framing-only shortfall (accomplished but underspecified framing)", async () => {
  // A live-arc quality signal at its poor floor is a shortfall (ADR-0017): an
  // accomplished session whose framing is underspecified still routes a cause.
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    framing: { value: "underspecified", anchors: [0] },
    attribution: { value: "framing", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const attribution = result.signals.find(
    (s) => s.signalName === "attribution",
  );
  expect(attribution).toBeDefined();
  expect(attribution!.value).toBe("framing");
});

test("attribution is kept on a conducting-only shortfall (accomplished but poorly-conducted)", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    conducting: { value: "poorly-conducted", anchors: [0] },
    attribution: { value: "conducting", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const attribution = result.signals.find(
    (s) => s.signalName === "attribution",
  );
  expect(attribution).toBeDefined();
  expect(attribution!.value).toBe("conducting");
});

test("attribution is still dropped on a clean success with good framing and conducting", async () => {
  // The poor-floor extension does not fire on the healthy values: an accomplished
  // session with clear framing and well-conducted steering is no shortfall.
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    framing: { value: "clear", anchors: [0] },
    conducting: { value: "well-conducted", anchors: [0] },
    attribution: { value: "framing", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "attribution"),
  ).toBeUndefined();
});

test("an out-of-vocab attribution value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "partial", anchors: [1] },
    attribution: { value: "user-error", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "attribution"),
  ).toBeUndefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("an out-of-vocab engagement value is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    engagement: { value: "half-engaged", anchors: [0] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "engagement"),
  ).toBeUndefined();
  // The other signals are unaffected (abstention is per-signal).
  expect(result.signals.find((s) => s.signalName === "intent")).toBeDefined();
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("an engagement value with no resolvable anchors abstains", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
    // Engagement cites only id 99 (not in the set): zero resolvable anchors -> absent.
    engagement: { value: "engaged", anchors: [99] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "engagement"),
  ).toBeUndefined();
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
  // The closed vocabularies and the prose-before-label rule are pinned.
  expect(request!.system).toContain("test-writing");
  expect(request!.system).toContain(
    "not-accomplished < partial < accomplished",
  );
  expect(request!.system).toContain("BEFORE");
  // Software quality and transcript length are explicit non-goals.
  expect(request!.system).toContain("software quality");
});

test("an out-of-vocab Intent is rejected, not coerced to other; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "documentation", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const intent = result.signals.find((s) => s.signalName === "intent");
  expect(intent).toBeUndefined();
  // The accomplishment still validates, so it is present (absence is per-signal).
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});

test("an accomplishment outside the ordinal values is rejected; the signal is absent", async () => {
  const text = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "great-success", anchors: [1] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeUndefined();
  expect(result.signals.find((s) => s.signalName === "intent")).toBeDefined();
});

test("a cited anchor not in the chunk set is dropped; a claim left with zero anchors abstains", async () => {
  const text = JSON.stringify({
    // Intent cites id 0 (valid) and id 99 (not in the set): id 0 survives.
    intent: { value: "test-writing", anchors: [99, 0] },
    assessment: { prose: "ok", anchors: [0] },
    // Accomplishment cites only id 99 (not in the set): zero resolvable anchors -> absent.
    accomplishment: { value: "accomplished", anchors: [99] },
  });
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: stubPort(text) },
  );
  const intent = result.signals.find((s) => s.signalName === "intent");
  expect(intent!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeUndefined();
});

/**
 * A scripted port that returns a different text on each call, so a test can
 * drive the retry loop (first call malformed, second well-formed).
 */
function scriptedPort(
  texts: string[],
  model = "claude-opus-4-8",
): JudgeModelPort & {
  calls: () => number;
  lastRequest: () => JudgeModelRequest | undefined;
} {
  let i = 0;
  let last: JudgeModelRequest | undefined;
  return {
    complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
      last = request;
      const text = texts[Math.min(i, texts.length - 1)]!;
      i += 1;
      return Promise.resolve({ text, model });
    },
    calls: () => i,
    lastRequest: () => last,
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

test("reasoning before the labels is enforced: an accomplishment with no assessment is not constructed", async () => {
  // A verdict with a valid accomplishment but no assessment prose: invalid by the
  // prose-before-label rule, so it drives the retry and then abstains.
  const noAssessment = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
  });
  const port = scriptedPort([noAssessment]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 1 },
  );
  expect(result.complete).toBe(false);
  expect(result.incompleteReason).toBe("llm-unparseable");
  // No accomplishment is constructed when the required assessment is absent.
  expect(
    result.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeUndefined();
});

test("reasoning before the labels is enforced for correction-cost: a correction-cost with no assessment is not constructed", async () => {
  // correction-cost is the co-equal second Outcome axis (ADR-0017), so the
  // prose-before-label rule gates it exactly as it gates accomplishment: a
  // correction-cost with no assessment prose drives the retry and then abstains.
  const noAssessment = JSON.stringify({
    intent: { value: "test-writing", anchors: [0] },
    "correction-cost": { value: "light", anchors: [0] },
  });
  const port = scriptedPort([noAssessment]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 1 },
  );
  expect(result.complete).toBe(false);
  expect(result.incompleteReason).toBe("llm-unparseable");
  expect(
    result.signals.find((s) => s.signalName === "correction-cost"),
  ).toBeUndefined();
});

test("a parseable verdict that grounds no signal is an insufficient-evidence run", async () => {
  // Well-formed JSON, but every claim abstains (no value, only an assessment).
  const thin = JSON.stringify({
    intent: { anchors: [0] },
    assessment: {
      prose: "Too little happened to judge intent or accomplishment.",
      anchors: [0],
    },
    accomplishment: { anchors: [1] },
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

/** A well-formed verdict whose assessment cites only a missing id (99). Its
 * signals still resolve, so the run would be complete; only the narrative is
 * under-anchored, driving the anchor repair-retry. */
const UNDER_ANCHORED_ASSESSMENT = JSON.stringify({
  intent: { value: "test-writing", anchors: [0] },
  assessment: {
    prose: "The engineer asked; the agent delivered.",
    anchors: [99],
  },
  accomplishment: { value: "accomplished", anchors: [1] },
});

/** A verdict where every valued signal cites only a missing id (99): all signals
 * drop, so absent a repair the run is insufficient-evidence. The assessment is
 * well-anchored so the narrative stands. */
const UNDER_ANCHORED_SIGNALS = JSON.stringify({
  intent: { value: "test-writing", anchors: [99] },
  assessment: {
    prose: "The engineer asked; the agent delivered.",
    anchors: [0],
  },
  accomplishment: { value: "accomplished", anchors: [99] },
});

test("a fully-anchored verdict is accepted on the first call with no anchor repair-retry", async () => {
  const port = scriptedPort([WELL_FORMED]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  expect(port.calls()).toBe(1);
  expect(result.complete).toBe(true);
});

test("an under-anchored assessment drives one repair-retry that recovers the anchors", async () => {
  const port = scriptedPort([UNDER_ANCHORED_ASSESSMENT, WELL_FORMED]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  // One initial call plus one anchor repair; the second response's anchors stuck.
  expect(port.calls()).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.narratives).toHaveLength(1);
  expect(result.narratives[0]!.anchors).toEqual([
    { eventHash: "a".repeat(64) },
    { eventHash: "b".repeat(64) },
  ]);
});

test("the anchor repair message tells the model its cited ids missed and to cite only real ids", async () => {
  const port = scriptedPort([UNDER_ANCHORED_ASSESSMENT, WELL_FORMED]);
  await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  const secondUser = port.lastRequest()!.user;
  expect(secondUser).toContain("assessment");
  expect(secondUser.toLowerCase()).toContain("cite only");
});

test("under-anchored anchors that stay bad after the one retry fall back to graceful degradation, keeping the prose", async () => {
  const port = scriptedPort([
    UNDER_ANCHORED_ASSESSMENT,
    UNDER_ANCHORED_ASSESSMENT,
  ]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  // Exactly one extra call: the anchor repair does not loop.
  expect(port.calls()).toBe(2);
  // The signals still resolved, so the run is complete; the prose is kept with
  // an empty anchor array rather than discarded.
  expect(result.complete).toBe(true);
  expect(result.narratives).toHaveLength(1);
  expect(result.narratives[0]!.prose).toContain("the agent delivered");
  expect(result.narratives[0]!.anchors).toEqual([]);
});

test("all-signals-under-anchored drives a repair-retry that rescues the run from insufficient-evidence", async () => {
  const port = scriptedPort([UNDER_ANCHORED_SIGNALS, WELL_FORMED]);
  const result = await judgeConversation(
    { sessionId: SESSION, chunks: CHUNKS },
    { llm: port, retryBudget: 2 },
  );
  expect(port.calls()).toBe(2);
  expect(result.complete).toBe(true);
  expect(result.incompleteReason).toBeUndefined();
  expect(result.signals.length).toBe(2);
});

test("omitting config.llm resolves the default judge adapter (no network here)", async () => {
  // When config.llm is omitted, judgeConversation resolves the production
  // adapter via resolveDefaultJudgeModel (spec section 3). With no key in env AND
  // no `claude` on PATH (PATH pinned empty so the CLI fallback finds nothing),
  // that resolution throws the no-backend error naming ANTHROPIC_API_KEY rather
  // than the old placeholder throw, proving the default seam is wired. No network
  // is made: the adapter is never invoked because construction fails first.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedPath = process.env.PATH;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = "";
  try {
    await expect(
      judgeConversation({ sessionId: SESSION, chunks: CHUNKS }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedPath !== undefined) process.env.PATH = savedPath;
  }
});
