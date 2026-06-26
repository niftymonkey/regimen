/**
 * The shared config-home resolver: where a harness keeps its configuration home,
 * derived from the shared contract. Both instruments import it rather than each
 * holding a byte-identical copy. The harness identity itself comes from the
 * shared `resolveHarnessFromEnvironment` policy; this resolver only maps an
 * already-known harness's contract to its config home, so adding a harness is a
 * contract entry, not a code change.
 */
import { join } from "node:path";
import type { HarnessContract } from "./contract.ts";

/**
 * The config home for a harness: the contract's config-home env var if set in
 * `env`, else `home` joined with the contract's default subdirectory. Takes the
 * env and home directory as arguments so callers under test pass fixed inputs.
 */
export function resolveHarnessHome(
  contract: HarnessContract,
  env: Partial<NodeJS.ProcessEnv>,
  home: string,
): string {
  const override = env[contract.configHome.envVar];
  if (typeof override === "string" && override.length > 0) return override;
  return join(home, contract.configHome.defaultSubdir);
}
