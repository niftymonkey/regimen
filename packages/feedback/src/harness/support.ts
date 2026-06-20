/**
 * The harness support REGISTRY: the single seam that binds a harness identifier
 * to everything the judge path needs for it, the descriptor (pure data) plus the
 * two behavior adapters. Mirrors the loader's TRANSLATORS map: one entry per
 * supported harness, looked up by normalized identifier, undefined when none is
 * registered. Adding a harness is one descriptor, one adapter pair, and one map
 * entry; the generic judge path never changes.
 *
 * `resolveHarnessHome` is the descriptor-driven generalization of
 * `resolveCodexHome`: it reads the config-home env var named by the contract,
 * falling back to the contract's default subdirectory of the user's home.
 */
import { join } from "node:path";
import { asHarness, type Harness } from "@regimen/shared";
import { claudeReader, claudeResolver } from "../claude/adapter.ts";
import { codexReader, codexResolver } from "../codex/adapter.ts";
import type { HarnessContract } from "@regimen/shared";
import {
  HARNESS_ENV_MARKERS,
  harnessDescriptor,
  type HarnessDescriptor,
} from "./descriptor.ts";
import type { SessionResolver, TranscriptReader } from "./ports.ts";

/** Everything the judge path needs for one harness: data plus the two ports. */
export interface HarnessSupport {
  readonly descriptor: HarnessDescriptor;
  readonly reader: TranscriptReader;
  readonly resolver: SessionResolver;
}

/** The reader+resolver adapter pair each harness binds, keyed by identifier. */
const ADAPTERS: ReadonlyMap<
  Harness,
  { readonly reader: TranscriptReader; readonly resolver: SessionResolver }
> = new Map([
  ["codex", { reader: codexReader, resolver: codexResolver }],
  ["claude", { reader: claudeReader, resolver: claudeResolver }],
]);

function supportFor(harness: Harness): HarnessSupport {
  const descriptor = harnessDescriptor(harness);
  if (descriptor === undefined) {
    throw new Error(`no harness descriptor registered for harness ${harness}`);
  }
  const adapters = ADAPTERS.get(harness);
  if (adapters === undefined) {
    throw new Error(`no harness adapters registered for harness ${harness}`);
  }
  return { descriptor, reader: adapters.reader, resolver: adapters.resolver };
}

const HARNESS_SUPPORT: ReadonlyMap<Harness, HarnessSupport> = new Map([
  ["codex", supportFor("codex")],
  ["claude", supportFor("claude")],
]);

/** The support bundle for `harness`, or undefined when none is registered. */
export function harnessSupport(harness: Harness): HarnessSupport | undefined {
  return HARNESS_SUPPORT.get(harness);
}

/**
 * Resolve which harness the CLI is running inside, vendor-agnostically and
 * per-invocation. An explicit `REGIMEN_HARNESS` wins: when set and non-empty it
 * is validated against the known harness set and returned, and an invalid value
 * throws rather than silently falling through, so a typo surfaces instead of
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

/**
 * The config home for a harness, generalized from `resolveCodexHome`: the
 * contract's config-home env var if set in `env`, else `home` joined with the
 * contract's default subdirectory. Takes the env and home directory as
 * arguments so callers under test pass fixed inputs.
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
