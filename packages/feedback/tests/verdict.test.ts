/**
 * The shared verdict pipeline (assembleVerdict), extracted from the Judge so the
 * in-process judge and the tier C agent recorder run the identical parse,
 * validity, closed-vocabulary, and anchor-membership rules over one raw verdict.
 * These tests exercise the pipeline directly through its public function; the
 * Judge's own suite exercises the same body through judgeConversation, and the
 * recorder's suite exercises it through the intake, so the two paths cannot drift.
 */
import { expect, test } from "bun:test";
import type {
  AnchorRef,
  ContentChunk,
} from "../src/loader/rollout/codex-reader.ts";
import { assembleVerdict } from "../src/judged/verdict.ts";

function chunk(
  lineSeq: number,
  kind: ContentChunk["kind"],
  text: string,
  anchor: AnchorRef,
): ContentChunk {
  return { kind, text, anchor, lineSeq };
}

const CHUNKS: ContentChunk[] = [
  chunk(0, "human_prompt", "add a test for the parser", {
    eventHash: "a".repeat(64),
  }),
  chunk(1, "assistant_answer", "Done, the parser test passes.", {
    eventHash: "b".repeat(64),
  }),
];

const WELL_FORMED = JSON.stringify({
  intent: { value: "test-writing", anchors: [0] },
  assessment: {
    prose: "The engineer asked for a parser test; the agent delivered it.",
    anchors: [0, 1],
  },
  accomplishment: { value: "accomplished", anchors: [1] },
});

test("a well-formed raw verdict assembles into anchored signals and the narrative", () => {
  const outcome = assembleVerdict(WELL_FORMED, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;

  const intent = outcome.signals.find((s) => s.signalName === "intent");
  expect(intent!.value).toBe("test-writing");
  expect(intent!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);

  const accomplishment = outcome.signals.find(
    (s) => s.signalName === "accomplishment",
  );
  expect(accomplishment!.value).toBe("accomplished");

  expect(outcome.narratives).toHaveLength(1);
  expect(outcome.narratives[0]!.narrativeType).toBe("assessment");
});

test("anchor ids emitted as numeric strings resolve to their chunks (model formatting variance)", () => {
  // Some judge models (observed: a Claude model through the OpenAI-compat
  // endpoint) emit the cited chunk ids as JSON strings ("3") rather than
  // numbers (3), even though the prompt shows them as bare numbers. Coercing
  // numeric-string ids keeps the whole verdict from collapsing to zero anchored
  // signals on that model, matching what models actually emit.
  const raw = JSON.stringify({
    intent: { value: "test-writing", anchors: ["0"] },
    assessment: {
      prose: "The engineer asked; the agent delivered.",
      anchors: ["0", "1"],
    },
    accomplishment: { value: "accomplished", anchors: ["1"] },
  });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;

  const intent = outcome.signals.find((s) => s.signalName === "intent");
  expect(intent!.anchors).toEqual([{ eventHash: "a".repeat(64) }]);
  expect(outcome.narratives).toHaveLength(1);
});

test("non-JSON raw text is rejected with the not-a-JSON-object reason", () => {
  const outcome = assembleVerdict("no json here", CHUNKS);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.reason).toBe("the response was not a JSON object");
});

test("a judgment label with no assessment prose is rejected (prose must precede the label)", () => {
  const raw = JSON.stringify({ accomplishment: { value: "accomplished" } });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.reason).toContain("assessment prose");
});

test("a valid verdict whose every claim cites an out-of-set id assembles to zero signals but keeps the under-anchored narrative", () => {
  const raw = JSON.stringify({
    intent: { value: "feature", anchors: [99] },
    assessment: { prose: "unanchorable", anchors: [99] },
  });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.signals).toHaveLength(0);
  // The prose is valid, so the narrative survives with an empty anchor array
  // (under-anchored, not fabricated) rather than being silently discarded.
  expect(outcome.narratives).toHaveLength(1);
  expect(outcome.narratives[0]!.anchors).toEqual([]);
});

test("prose with only unresolved anchors keeps the narrative with an empty anchor array (under-anchored, not fabricated)", () => {
  const raw = JSON.stringify({
    intent: { value: "feature", anchors: [0] },
    assessment: { prose: "The agent shipped the feature.", anchors: [99] },
    accomplishment: { value: "accomplished", anchors: [1] },
  });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.narratives).toHaveLength(1);
  expect(outcome.narratives[0]!.prose).toBe("The agent shipped the feature.");
  expect(outcome.narratives[0]!.anchors).toEqual([]);
});

test("prose with a mix of resolved and unresolved anchors keeps only the resolved ones", () => {
  const raw = JSON.stringify({
    intent: { value: "feature", anchors: [0] },
    assessment: { prose: "Some of these anchors are real.", anchors: [99, 1] },
    accomplishment: { value: "accomplished", anchors: [1] },
  });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.narratives).toHaveLength(1);
  expect(outcome.narratives[0]!.anchors).toEqual([
    { eventHash: "b".repeat(64) },
  ]);
});

test("no assessment prose yields no narrative", () => {
  const raw = JSON.stringify({
    intent: { value: "feature", anchors: [0] },
  });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.narratives).toHaveLength(0);
});

test("an out-of-vocabulary signal value is dropped rather than assembled", () => {
  const raw = JSON.stringify({
    intent: { value: "not-a-real-intent", anchors: [0] },
    assessment: { prose: "ok", anchors: [0] },
    accomplishment: { value: "accomplished", anchors: [1] },
  });
  const outcome = assembleVerdict(raw, CHUNKS);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(
    outcome.signals.find((s) => s.signalName === "intent"),
  ).toBeUndefined();
  expect(
    outcome.signals.find((s) => s.signalName === "accomplishment"),
  ).toBeDefined();
});
