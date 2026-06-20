/**
 * Anchor-consistency tests across the reader's two folds and the store.
 *
 * The content projection anchors `human_prompt` and `assistant_answer` chunks
 * by `{eventHash}` (ADR-0008), the lowercase-hex of a structural event's
 * event_hash. For a downstream judge to resolve those anchors, the structural
 * fold (`rolloutRead().events`) must contain exactly the events whose hashes
 * those anchors target. These tests insert every event a fixture yields into a
 * real store, then assert each content `{eventHash}` anchor resolves to an
 * inserted row, and that tool / web-search anchors still resolve through their
 * own keys. This is the regression guard for the fold-divergence blocker: a
 * `seq`-less `user_prompt` from the dedup `event_msg` twin and a missing
 * `agent.message` left prompt/answer anchors unresolvable (0/2 and 0/7).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rolloutRead,
  type AnchorRef,
} from "../src/loader/rollout/codex-reader.ts";
import { openStore } from "../src/store.ts";

const SAMPLES = join(import.meta.dir, "..", "samples");

function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

function withStore(fn: (store: ReturnType<typeof openStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-anchor-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function isEventHashAnchor(
  anchor: AnchorRef,
): anchor is { readonly eventHash: string } {
  return "eventHash" in anchor;
}

function isToolAnchor(
  anchor: AnchorRef,
): anchor is { readonly sessionId: string; readonly toolCallId: string } {
  return "toolCallId" in anchor;
}

/** Whether a content `{eventHash}` anchor resolves to a stored events row. */
function eventHashResolves(
  store: ReturnType<typeof openStore>,
  eventHash: string,
): boolean {
  const row = store.db
    .prepare("SELECT 1 FROM events WHERE event_hash = ?")
    .get(Buffer.from(eventHash, "hex"));
  return row !== null;
}

/** Whether a tool `{sessionId, toolCallId}` anchor resolves to a stored span. */
function toolAnchorResolves(
  store: ReturnType<typeof openStore>,
  sessionId: string,
  toolCallId: string,
): boolean {
  const row = store.db
    .prepare(
      "SELECT 1 FROM tool_call_spans WHERE session_id = ? AND tool_call_id = ?",
    )
    .get(sessionId, toolCallId);
  return row !== null;
}

test("every content anchor resolves after inserting the rollout's events (recent-clean baseline)", () => {
  withStore((store) => {
    const { events, content } = rolloutRead(
      fixture("rollout-codex-recent-clean.jsonl"),
      { complete: true },
    );
    for (const event of events) store.insertEvent(event);

    const human = content.filter((c) => c.kind === "human_prompt");
    const answers = content.filter((c) => c.kind === "assistant_answer");
    const webSearches = content.filter((c) => c.kind === "web_search_query");
    const tools = content.filter(
      (c) => c.kind === "tool_args" || c.kind === "tool_output",
    );
    // The blocker measured these populations on this very fixture.
    expect(human.length).toBe(2);
    expect(answers.length).toBe(7);
    expect(webSearches.length).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(0);

    const resolved = (kind: string): number =>
      content
        .filter((c) => c.kind === kind && isEventHashAnchor(c.anchor))
        .filter(
          (c) =>
            isEventHashAnchor(c.anchor) &&
            eventHashResolves(store, c.anchor.eventHash),
        ).length;

    // 0/2 -> 2/2 and 0/7 -> 7/7: prompt and answer anchors now resolve.
    expect(resolved("human_prompt")).toBe(2);
    expect(resolved("assistant_answer")).toBe(7);
    // Web-search anchors are also event-hash anchors and keep resolving.
    expect(resolved("web_search_query")).toBe(webSearches.length);

    // Tool anchors resolve through the tool_call_spans PK, unchanged.
    for (const c of tools) {
      expect(isToolAnchor(c.anchor)).toBe(true);
      if (isToolAnchor(c.anchor)) {
        expect(
          toolAnchorResolves(store, c.anchor.sessionId, c.anchor.toolCallId),
        ).toBe(true);
      }
    }
  });
});

test("across every Codex rollout fixture, no content event-hash anchor is left unresolved", () => {
  const names = [
    "rollout-codex-mid-error-edge.jsonl",
    "rollout-codex-mid-guardian-subagent.jsonl",
    "rollout-codex-mid-rich-tools.jsonl",
    "rollout-codex-oldest-0.35.0.jsonl",
    "rollout-codex-recent-clean.jsonl",
    "rollout-codex-recent-devbox.jsonl",
    "rollout-codex-session.jsonl",
    "rollout-codex-timestamp-collision.jsonl",
    "rollout-shell-session.jsonl",
  ];
  for (const name of names) {
    withStore((store) => {
      const { events, content } = rolloutRead(fixture(name), {
        complete: true,
      });
      for (const event of events) store.insertEvent(event);
      for (const c of content) {
        if (isEventHashAnchor(c.anchor)) {
          expect(
            eventHashResolves(store, c.anchor.eventHash),
            `${name}: ${c.kind} anchor ${c.anchor.eventHash} unresolved`,
          ).toBe(true);
        }
      }
    });
  }
});
