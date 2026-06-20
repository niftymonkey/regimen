/**
 * The single shared harness-resolution policy, vendor-agnostic and
 * per-invocation. Pure category-1: the environment is passed in, nothing here
 * reads `process.env`. Both Regimen instruments resolve the running harness the
 * same way through this one function, so a non-Claude harness is never
 * mislabelled.
 */
import { asHarness, type Harness } from "../harness.ts";

/**
 * The CLI-set environment marker each harness stamps into the agent's shell,
 * the one sanctioned place a harness name is bound to a concrete env var. The
 * resolver reads this map to detect which harness the CLI is running inside; a
 * harness whose marker env var is present and non-empty is that harness.
 *
 * These are the markers the harness CLI sets, NOT generic provider keys: a model
 * provider's API key (e.g. an Anthropic key in the shell) does not imply the
 * Claude Code CLI is the running harness.
 */
export const HARNESS_ENV_MARKERS: ReadonlyMap<Harness, string> = new Map([
  ["claude", "CLAUDECODE"],
  ["codex", "CODEX_THREAD_ID"],
  ["gemini", "GEMINI_CLI"],
  ["copilot", "COPILOT_CLI"],
]);

/**
 * Resolve which harness the CLI is running inside, vendor-agnostically and
 * per-invocation. An explicit `REGIMEN_HARNESS` wins: when set and non-empty it
 * is validated against the known harness set and returned, and an invalid value
 * THROWS rather than silently falling through, so a typo surfaces instead of
 * being masked by detection. With no override, the first harness whose CLI-set
 * marker env var (HARNESS_ENV_MARKERS) is present and non-empty is returned;
 * with neither override nor any marker, the result is undefined and the caller
 * fails closed.
 */
export function resolveHarnessFromEnvironment(
  env: Partial<NodeJS.ProcessEnv>,
): Harness | undefined {
  const override = env.REGIMEN_HARNESS;
  if (typeof override === "string" && override.length > 0) {
    const harness = asHarness(override);
    if (harness === undefined) {
      throw new Error(
        `REGIMEN_HARNESS is set to an unknown harness: ${override}`,
      );
    }
    return harness;
  }
  for (const [harness, marker] of HARNESS_ENV_MARKERS) {
    const value = env[marker];
    if (typeof value === "string" && value.length > 0) return harness;
  }
  return undefined;
}
