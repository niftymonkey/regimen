/**
 * `@regimen/shared`: the pure category-1 leaf both Feedback and Enforcement
 * import (with the bridge as a third consumer of the data-dir resolver). It
 * holds data and pure helpers only: the known-harness set and its narrowing
 * helper, the OTLP trace-id derivation, the data-directory resolver, and the
 * harness contract data. No ports, no adapters, no I/O beyond the data-dir
 * resolver's env read.
 */
export { HARNESSES, asHarness, type Harness } from "./harness.ts";
export { traceIdFor } from "./trace.ts";
export { resolveDataDir, dataDir, bufferDir } from "./data-dir.ts";
export {
  HARNESS_CONTRACTS,
  harnessContract,
  type ConfigHome,
  type HarnessContract,
  type HooksFile,
  type HooksFormat,
} from "./harness/contract.ts";
export {
  HARNESS_ENV_MARKERS,
  resolveHarnessFromEnvironment,
} from "./harness/resolve.ts";
export { resolveHarnessHome } from "./harness/home.ts";
export {
  planHooks,
  planHooksRemoval,
  type BuiltLeaves,
  type GroupDecoration,
  type HooksFile as ParsedHooksFile,
  type LeafHook,
  type MatcherGroup,
  type RegimenMarker,
  type UnwirePlan,
  type VersionedHooksFile,
  type WirePlan,
  type WireRole,
} from "./install/hooks-engine.ts";
export { assertSafeClonePath } from "./install/clone-path.ts";
export {
  BUNDLED_SKILLS,
  planSkillInstall,
  type SkillInstallContext,
  type SkillInstallPlan,
} from "./install/skill.ts";
