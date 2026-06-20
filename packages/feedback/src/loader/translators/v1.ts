/**
 * Structural validator for already-translated v1 events on the buffer.
 *
 * A buffer line missing the envelope's `payload` key is treated as an
 * already-translated v1 event per ADR-0006's cutover note. The loader
 * cannot trust the line blindly: this validator checks the required
 * fields exist with the right shapes before the writer hashes and inserts.
 *
 * The check is structural, not the full JSON Schema in
 * `schemas/event.schema.json`: it costs one shallow walk of the object
 * rather than an Ajv compile per line, and the schema is enforced by the
 * tests in `tests/event-schema.test.ts` and by the producers that mint
 * these events.
 */
import { asHarness } from "@regimen/shared";
import { type RegimenEvent, type SpanPhase } from "../../../hooks/event-log.ts";
import type { TranslateResult } from "../../envelope.ts";

const SPAN_PHASES: ReadonlySet<SpanPhase> = new Set(["start", "end", "point"]);
const EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.start",
  "session.end",
  "user_prompt",
  "tool.pre",
  "tool.post",
  "compaction",
  "gate.denial",
]);

export function validateV1Event(obj: Record<string, unknown>): TranslateResult {
  if (obj.schema_version !== 1) {
    return {
      kind: "quarantine",
      reason: `unsupported schema_version ${String(obj.schema_version)}`,
    };
  }
  const harness =
    typeof obj.harness === "string" ? asHarness(obj.harness) : undefined;
  if (harness === undefined) {
    return {
      kind: "quarantine",
      reason: `v1 event has unknown harness ${String(obj.harness)}`,
    };
  }
  if (typeof obj.event_type !== "string" || !EVENT_TYPES.has(obj.event_type)) {
    return {
      kind: "quarantine",
      reason: `v1 event has unknown event_type ${String(obj.event_type)}`,
    };
  }
  if (
    typeof obj.span_phase !== "string" ||
    !SPAN_PHASES.has(obj.span_phase as SpanPhase)
  ) {
    return {
      kind: "quarantine",
      reason: `v1 event has unknown span_phase ${String(obj.span_phase)}`,
    };
  }
  if (typeof obj.timestamp !== "string" || obj.timestamp.length === 0) {
    return { kind: "quarantine", reason: "v1 event missing timestamp" };
  }
  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    return { kind: "quarantine", reason: "v1 event missing session_id" };
  }
  if (typeof obj.trace_id !== "string" || obj.trace_id.length === 0) {
    return { kind: "quarantine", reason: "v1 event missing trace_id" };
  }
  if (typeof obj.span_name !== "string" || obj.span_name.length === 0) {
    return { kind: "quarantine", reason: "v1 event missing span_name" };
  }
  if (
    typeof obj.attributes !== "object" ||
    obj.attributes === null ||
    Array.isArray(obj.attributes)
  ) {
    return {
      kind: "quarantine",
      reason: "v1 event missing attributes object",
    };
  }
  const event: RegimenEvent = {
    schema_version: 1,
    timestamp: obj.timestamp,
    session_id: obj.session_id,
    harness,
    ...(typeof obj.model === "string" && obj.model.length > 0
      ? { model: obj.model }
      : {}),
    ...(typeof obj.cwd === "string" && obj.cwd.length > 0
      ? { cwd: obj.cwd }
      : {}),
    event_type: obj.event_type,
    trace_id: obj.trace_id,
    span_phase: obj.span_phase as SpanPhase,
    span_name: obj.span_name,
    attributes: obj.attributes as Record<string, string>,
  };
  return { kind: "event", event };
}
