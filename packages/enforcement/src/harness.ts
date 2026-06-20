/**
 * Enforcement's config-home resolution seam: where the harness it is wiring
 * keeps its configuration home. The harness identity itself comes from the
 * shared `resolveHarnessFromEnvironment` policy (explicit REGIMEN_HARNESS, else
 * the CLI-set marker, else fail closed), the same policy Feedback uses, so a
 * non-Claude harness is never mislabelled. The config-home resolver reads the
 * env var named by the shared contract, so adding a harness is a contract entry,
 * not a code change.
 */
import { join } from "node:path";
import type { HarnessContract } from "@regimen/shared";

export function resolveHarnessHome(
  contract: HarnessContract,
  env: Partial<NodeJS.ProcessEnv>,
  home: string,
): string {
  const override = env[contract.configHome.envVar];
  if (typeof override === "string" && override.length > 0) return override;
  return join(home, contract.configHome.defaultSubdir);
}
