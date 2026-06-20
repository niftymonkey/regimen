/**
 * Enforcement's harness resolution seam: how the install CLI and the gate
 * commands learn which agent CLI they are wiring, and where that harness keeps
 * its configuration home.
 *
 * Enforcement is always invoked with REGIMEN_HARNESS set (by the Regimen CLI or
 * by the gate command line), so it resolves the harness from that one variable
 * and FAILS CLOSED when it is unset or unknown. Unlike Feedback, Enforcement
 * does NOT detect the harness from per-CLI env markers: marker detection stays
 * Feedback-private. The config-home resolver reads the env var named by the
 * shared contract, so adding a harness is a contract entry, not a code change.
 */
import { join } from "node:path";
import { asHarness, type Harness, type HarnessContract } from "@regimen/shared";

export function resolveHarness(
  env: Partial<NodeJS.ProcessEnv>,
): Harness | undefined {
  const override = env.REGIMEN_HARNESS;
  if (typeof override !== "string" || override.length === 0) return undefined;
  const harness = asHarness(override);
  if (harness === undefined) {
    throw new Error(
      `REGIMEN_HARNESS is set to an unknown harness: ${override}`,
    );
  }
  return harness;
}

export function resolveHarnessHome(
  contract: HarnessContract,
  env: Partial<NodeJS.ProcessEnv>,
  home: string,
): string {
  const override = env[contract.configHome.envVar];
  if (typeof override === "string" && override.length > 0) return override;
  return join(home, contract.configHome.defaultSubdir);
}
