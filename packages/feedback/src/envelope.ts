/**
 * The buffer's wire format and the loader's dispatch result type.
 *
 * Per ADR-0006, the capture hook appends one envelope JSON line per event:
 * the raw harness payload wrapped with the harness identifier and the time
 * the hook ran. The loader's translator registry consumes envelopes, looks
 * up the per-harness translator, and produces a canonical v1 event (or a
 * skip or quarantine outcome). v1 events produced directly by an external
 * producer over the store-write contract still flow through the same dispatch
 * path; ADR-0006 specifies that a JSON line missing a top-level `payload` key is
 * treated as an already-translated v1 event so the cutover from the prior wire
 * format loses no data.
 */
import type { RegimenEvent } from "../hooks/event-log.ts";

/** One line of the buffer in envelope wire format. */
export interface Envelope {
  readonly harness: string;
  readonly captured_at: string;
  readonly payload: unknown;
}

/**
 * Outcome of translating one buffer line into a v1 event. `skip` covers a
 * payload the harness fired but the schema does not map (for example, a
 * Claude `Notification` event); `quarantine` covers any line we cannot
 * trust enough to insert, so the loader records it in `quarantine` and
 * continues.
 */
export type TranslateResult =
  | { readonly kind: "event"; readonly event: RegimenEvent }
  | { readonly kind: "skip" }
  | { readonly kind: "quarantine"; readonly reason: string };

/**
 * Read a string field from an untrusted payload, or undefined when absent
 * or empty. A separate helper from the schema's stricter checks so callers
 * (translators) can decide what to do with a missing value.
 */
export function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read the invoked skill's identity from a tool call's `tool_input`, or
 * undefined when the call is not a skill invocation. The Skill tool exposes
 * the skill slug as `tool_input.skill`; retaining it is what lets the
 * evidence layer attribute behaviour to a named skill rather than to an
 * anonymous Skill tool call. Harness-agnostic: any harness whose skill tool
 * names the skill on this field is captured by the same reader, so the Claude
 * and Codex hook translators stay consistent by sharing it.
 */
export function readSkillName(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  return readString(toolInput as Record<string, unknown>, "skill");
}
