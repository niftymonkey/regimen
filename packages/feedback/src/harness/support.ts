/**
 * The harness support REGISTRY: the single seam that binds a harness identifier
 * to everything the judge path needs for it, the descriptor (pure data) plus the
 * two behavior adapters. Mirrors the loader's TRANSLATORS map: one entry per
 * supported harness, looked up by normalized identifier, undefined when none is
 * registered. Adding a harness is one descriptor, one adapter pair, and one map
 * entry; the generic judge path never changes.
 */
import type { Harness } from "@regimen/shared";
import { claudeReader, claudeResolver } from "../claude/adapter.ts";
import { codexReader, codexResolver } from "../codex/adapter.ts";
import { copilotReader, copilotResolver } from "../copilot/adapter.ts";
import { geminiReader, geminiResolver } from "../gemini/adapter.ts";
import { harnessDescriptor, type HarnessDescriptor } from "./descriptor.ts";
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
  ["copilot", { reader: copilotReader, resolver: copilotResolver }],
  ["gemini", { reader: geminiReader, resolver: geminiResolver }],
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
  ["copilot", supportFor("copilot")],
  ["gemini", supportFor("gemini")],
]);

/** The support bundle for `harness`, or undefined when none is registered. */
export function harnessSupport(harness: Harness): HarnessSupport | undefined {
  return HARNESS_SUPPORT.get(harness);
}
