/**
 * The translator registry and the loader's dispatch entry point.
 *
 * Per ADR-0006, the translator registry is the only harness-specific seam
 * in the loader: a normalized harness identifier maps to a stateless pure
 * function from envelope to v1 event. Adding a harness is one new
 * translator file plus one map entry; nothing else in the loader changes.
 *
 * `dispatchLine` is the writer's entry point: parse one JSON line from the
 * buffer, decide whether it is an envelope or an already-translated v1
 * event (per ADR-0006's cutover note: lines missing a top-level `payload`
 * key are treated as v1 events), and resolve to one TranslateResult the
 * writer routes into the events table or the quarantine table.
 */
import { asHarness, type Harness } from "@regimen/shared";
import { type Envelope, type TranslateResult } from "../../envelope.ts";
import { translateClaude } from "./claude.ts";
import { translateCodex } from "./codex.ts";
import { translateCopilot } from "./copilot.ts";
import { translateGemini } from "./gemini.ts";
import { validateV1Event } from "./v1.ts";

type Translator = (envelope: Envelope) => TranslateResult;

const TRANSLATORS: ReadonlyMap<Harness, Translator> = new Map([
  ["claude", translateClaude],
  ["codex", translateCodex],
  ["copilot", translateCopilot],
  ["gemini", translateGemini],
]);

/** Translate one envelope through the registry. */
export function translateEnvelope(envelope: Envelope): TranslateResult {
  const harness = asHarness(envelope.harness);
  if (harness === undefined) {
    return {
      kind: "quarantine",
      reason: `unknown harness: ${envelope.harness}`,
    };
  }
  const translator = TRANSLATORS.get(harness);
  if (translator === undefined) {
    return {
      kind: "quarantine",
      reason: `no translator registered for harness ${harness}`,
    };
  }
  return translator(envelope);
}

/**
 * The loader's per-line dispatch: parse one JSONL line and resolve it to a
 * v1 event, a skip, or a quarantine outcome.
 *
 * The line is one of:
 *   - An envelope `{ harness, captured_at, payload }` from the capture hook.
 *     Looked up via the translator registry.
 *   - An already-translated v1 event (from an external producer writing across
 *     the store-write contract, or from a buffer written before the envelope
 *     cutover). Validated structurally and returned as-is.
 *   - Anything else: quarantine.
 */
export function dispatchLine(line: string): TranslateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return {
      kind: "quarantine",
      reason: `JSON parse failure: ${(err as Error).message}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "quarantine", reason: "line is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if ("payload" in obj) {
    if (typeof obj.harness !== "string") {
      return {
        kind: "quarantine",
        reason: "envelope missing string `harness`",
      };
    }
    if (typeof obj.captured_at !== "string") {
      return {
        kind: "quarantine",
        reason: "envelope missing string `captured_at`",
      };
    }
    return translateEnvelope({
      harness: obj.harness,
      captured_at: obj.captured_at,
      payload: obj.payload,
    });
  }

  return validateV1Event(obj);
}
