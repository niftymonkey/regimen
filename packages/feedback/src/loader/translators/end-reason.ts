/**
 * The normalized session-end-reason vocabulary and the per-harness pure
 * functions that map a harness's native end reason onto it.
 *
 * A `session.end` event records two additive things: the harness-native end
 * reason exactly as the harness reported it, and a normalized value drawn
 * from this small harness-agnostic vocabulary. The vocabulary is the minimal
 * set the implemented harnesses produce, with an explicit catch-all `other`
 * that absorbs an unrecognized native reason or the absence of one; it
 * extends additively as new harness adapters land (the cross-harness
 * portability studies in `niftymonkey/skills` under `docs/portability/` are
 * the prior art for that extension). Normalization never fails: an unknown or
 * missing native reason maps to `other` rather than quarantining the event.
 *
 * Per-harness mapping is a pure function so it is trivially unit-testable
 * and lives at the harness edge, the only place harness-specific knowledge
 * is allowed.
 */

/**
 * The normalized, harness-agnostic session-end reasons. This is the minimal
 * set the implemented harnesses (Claude, Codex) actually produce, with a
 * mandatory catch-all; it extends additively as new harness adapters land:
 *   - `user_exit`: the operator deliberately ended the session (a clean exit).
 *   - `cleared`: the session was reset/cleared in place, distinct from a full
 *     exit.
 *   - `other`: the catch-all for an unrecognized native reason or none.
 */
export type NormalizedEndReason = "user_exit" | "cleared" | "other";

/**
 * Claude's `SessionEnd.reason` values, mapped onto the normalized vocabulary.
 * The native values are `clear | logout | prompt_input_exit | other`
 * (Claude Code SDK `SessionEndHookInput`). `prompt_input_exit` (the user runs
 * /exit) and `logout` are deliberate operator exits; `clear` resets the
 * session in place; Claude's own `other` and anything unrecognized fall to
 * the catch-all.
 */
const CLAUDE_END_REASONS: Readonly<Record<string, NormalizedEndReason>> = {
  prompt_input_exit: "user_exit",
  logout: "user_exit",
  clear: "cleared",
};

/** Map a Claude `SessionEnd.reason` value onto the normalized vocabulary. */
export function normalizeClaudeEndReason(
  native: string | undefined,
): NormalizedEndReason {
  if (native === undefined) return "other";
  return CLAUDE_END_REASONS[native] ?? "other";
}

/**
 * Codex's native end reasons, mapped onto the normalized vocabulary. Empty
 * today: Codex has no `SessionEnd` hook (its `Stop`/`SubagentStop` are
 * turn-scoped, not session-scoped), so the session boundary comes from the
 * rollout tailer with no native reason. A future Codex end-reason surface is
 * a one-line addition here, parallel to the Claude table.
 */
const CODEX_END_REASONS: Readonly<Record<string, NormalizedEndReason>> = {};

/**
 * Map a Codex native end reason onto the normalized vocabulary. Every Codex
 * session.end normalizes to the catch-all today, since Codex exposes no native
 * reason; an absent or unrecognized reason maps to `other` rather than failing.
 */
export function normalizeCodexEndReason(
  native: string | undefined,
): NormalizedEndReason {
  if (native === undefined) return "other";
  return CODEX_END_REASONS[native] ?? "other";
}
