/**
 * The store-write seam for the Enforcement instrument: how a discipline gate
 * records a gate.denial event across the open-format buffer seam (ADR-0005)
 * WITHOUT importing Feedback's row types.
 *
 * Enforcement reproduces the v1 gate.denial line shape the published store-write
 * contract (Feedback's docs/store-write-contract.md) specifies, rather than
 * importing a shared row type, so the seam stays open to any future producer.
 * The pure helpers the contract references, the harness set, the frozen
 * trace_id derivation, and the data-directory resolver, come from
 * `@regimen/shared`. It writes one JSON line across the seam; Feedback's loader
 * drains that line into its store.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  asHarness,
  traceIdFor,
  resolveDataDir,
  dataDir,
  type Harness,
} from "@regimen/shared";

/**
 * Re-exported from the seam module so the gates and the conformance test resolve
 * the harness and data dir through one import. resolveDataDir(env, platform) is
 * the pure form; dataDir() resolves for the running process, per OS, exactly as
 * the store-write contract documents Feedback's own resolution.
 */
export { asHarness, resolveDataDir, dataDir, type Harness };

/** One v1 event in the append-only buffer. Matches Feedback's event schema. */
export interface RegimenEvent {
  schema_version: 1;
  timestamp: string;
  session_id: string;
  harness: Harness;
  model?: string;
  event_type: "gate.denial";
  trace_id: string;
  span_phase: "point";
  span_name: string;
  attributes: Record<string, string>;
}

/** The normalized inputs a gate hands over when it denies a tool call. */
export interface GateDenialInput {
  gate_id: string;
  session_id: string;
  harness: Harness;
  tool_name: string;
  tool_call_id: string;
  reason?: string;
  model?: string;
}

/**
 * Build a gate.denial v1 event per the store-write contract. Pure: the gate, at
 * its harness-specific edge, has already normalized its native hook payload into
 * these fields. Optional fields (model, reason) are omitted when undefined to
 * match the contract's line shape exactly.
 */
export function buildGateDenialLine(input: GateDenialInput): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    harness: input.harness,
    ...(input.model !== undefined ? { model: input.model } : {}),
    event_type: "gate.denial",
    trace_id: traceIdFor(input.session_id),
    span_phase: "point",
    span_name: `gate:${input.gate_id}`,
    attributes: {
      gate_id: input.gate_id,
      tool_name: input.tool_name,
      tool_call_id: input.tool_call_id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  };
}

/**
 * Append one already-built v1 gate.denial as a JSON line to
 * <dataDir>/buffer/current.jsonl, per the contract's append semantics: mkdir -p
 * the buffer directory first (it may not exist on a fresh install), then append
 * one newline-terminated line. The buffer is append-only, so this never rewrites
 * existing bytes and concurrent producers are safe.
 */
export function appendGateDenial(dataDir: string, event: RegimenEvent): void {
  const dir = join(dataDir, "buffer");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "current.jsonl"), `${JSON.stringify(event)}\n`);
}
