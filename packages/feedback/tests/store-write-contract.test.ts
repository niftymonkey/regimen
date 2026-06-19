/**
 * Conformance guard for the store-write contract (docs/store-write-contract.md).
 *
 * This test stands in for an EXTERNAL producer: the future regimen-enforcement
 * denial emitter, a process that cannot import Feedback's TypeScript modules and
 * must write across the open-format buffer seam (ADR-0005). So it deliberately
 * does NOT import buildGateDenialEvent or appendEvent from hooks/event-log.ts.
 * It builds the gate.denial v1 line from raw primitives, derives trace_id inline
 * per the documented algorithm, resolves the buffer the documented way, appends
 * one line, then drains it through the REAL loader and asserts the event landed
 * in events, gate_denials, and the conversation_counts view.
 *
 * The one Feedback symbol it imports is traceIdFor, used only as the drift guard:
 * the externally-derived trace_id must equal Feedback's own derivation. If
 * Feedback ever changes the derivation, this assertion fails loudly, signaling
 * the published contract must be revised rather than silently orphaning every
 * external producer's events into a different trace.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { traceIdFor, bufferDir } from "@regimen/shared";
import { drainBuffer } from "../src/loader/drain.ts";
import { openStore } from "../src/store.ts";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const SESSION = "claude-external-producer-9f3a";
const GATE_ID = "rm-rf-guard";
const TOOL_NAME = "Bash";
const TOOL_CALL_ID = "toolu_extprod01";
const REASON = "recursive forced rm denied";

/**
 * Derive trace_id exactly as docs/store-write-contract.md documents it:
 * sha256 of "trace:" + session_id, hex, first 32 chars. Reimplemented here
 * with node:crypto rather than imported, so this is what an out-of-process
 * producer in a Node-family runtime would write.
 */
function externalTraceId(sessionId: string): string {
  return createHash("sha256")
    .update(`trace:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

test("an external producer's gate.denial line drains into the store across the buffer seam", () => {
  // Resolve the buffer the documented way: REGIMEN_DATA_DIR overrides the
  // per-OS default, then <dataDir>/buffer/current.jsonl.
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-store-write-"));
  const store = openStore(":memory:");
  try {
    const dir = bufferDir(dataDir);

    // Build the v1-direct line from raw primitives: no top-level `payload`
    // key (so the loader treats it as an already-translated v1 event), and
    // no Feedback builder. event_hash is NOT computed; the store does that.
    const line = {
      schema_version: 1,
      timestamp: "2026-06-15T17:42:09.000Z",
      session_id: SESSION,
      harness: "claude",
      event_type: "gate.denial",
      trace_id: externalTraceId(SESSION),
      span_phase: "point",
      span_name: `gate:${GATE_ID}`,
      attributes: {
        gate_id: GATE_ID,
        tool_name: TOOL_NAME,
        tool_call_id: TOOL_CALL_ID,
        reason: REASON,
      },
    };

    // The externally-built line is schema-valid before it ever reaches the store.
    const isValid = validate(line);
    expect(isValid).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    // Append one newline-terminated line, mkdir -p first, exactly as the
    // contract's append semantics describe.
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "current.jsonl"), `${JSON.stringify(line)}\n`);

    // Drain through the real loader path.
    const result = drainBuffer(dir, store);
    expect(result.events_inserted).toBe(1);
    expect(result.quarantined).toBe(0);

    // The event landed in the events table.
    const event = store.db
      .prepare(
        "SELECT session_id, event_type, span_phase, span_name, trace_id FROM events",
      )
      .get() as {
      session_id: string;
      event_type: string;
      span_phase: string;
      span_name: string;
      trace_id: string;
    };
    expect(event.session_id).toBe(SESSION);
    expect(event.event_type).toBe("gate.denial");
    expect(event.span_phase).toBe("point");
    expect(event.span_name).toBe(`gate:${GATE_ID}`);

    // It projected into gate_denials.
    const denial = store.db
      .prepare(
        "SELECT session_id, gate_id, tool_name, tool_call_id, reason FROM gate_denials",
      )
      .get() as {
      session_id: string;
      gate_id: string;
      tool_name: string;
      tool_call_id: string;
      reason: string;
    };
    expect(denial).toEqual({
      session_id: SESSION,
      gate_id: GATE_ID,
      tool_name: TOOL_NAME,
      tool_call_id: TOOL_CALL_ID,
      reason: REASON,
    });

    // The conversation_counts view counts it as one gate denial.
    const counts = store.db
      .prepare(
        "SELECT gate_denial_count FROM conversation_counts WHERE session_id = ?",
      )
      .get(SESSION) as { gate_denial_count: number };
    expect(counts.gate_denial_count).toBe(1);

    // Drift guard: the externally-derived trace_id matches Feedback's own.
    // If Feedback ever changes traceIdFor, this fails and the published
    // contract must be revised.
    expect(event.trace_id).toBe(externalTraceId(SESSION));
    expect(externalTraceId(SESSION)).toBe(traceIdFor(SESSION));
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
