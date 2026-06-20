/**
 * The known agent harnesses Regimen admits, as normalized identifiers, and the
 * helper that narrows an untrusted string to one. Pure data and computation:
 * the sanctioned home for the harness identifier set, shared byte-for-byte
 * across Feedback and Enforcement rather than hand-copied in each.
 */

/** The agent harnesses the schema admits, as normalized identifiers. */
export const HARNESSES = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "opencode",
  "copilot",
] as const;
export type Harness = (typeof HARNESSES)[number];

/** Narrow an untrusted string to a known harness identifier, else undefined. */
export function asHarness(value: string): Harness | undefined {
  return HARNESSES.find((harness) => harness === value);
}
