/**
 * Projection: a traces batch to an OTLP `TracesData` message.
 *
 * The Source has already done the honest-over-tidy filtering: only closed
 * conversations reach `sessionSpans`, only closed tool calls reach
 * `toolSpans`. This projection only shapes. A point event whose session has
 * no session span still emits; it parents to the deterministic session span
 * id, so an unfinished session renders as a rootless trace, which is the
 * accurate artifact, not a defect.
 *
 * Span ids are minted deterministically from row identity, so re-projecting
 * the same row yields the same id and an OTLP receiver overwrites rather than
 * duplicates.
 */
import type {
  LogRow,
  SessionSpanRow,
  ToolSpanRow,
  TracesBatch,
} from "../source/types.ts";
import {
  type KeyValue,
  type OtlpSpan,
  type TracesData,
  SPAN_KIND_INTERNAL,
  mintSpanId,
  stringAttr,
  toUnixNano,
} from "../otlp.ts";
import { type ProjectionOptions, resourceAttributes } from "./resource.ts";

/** The deterministic span id of a session's root span. */
function sessionSpanId(sessionId: string): string {
  return mintSpanId(`session:${sessionId}`);
}

/** Build an OTLP span, defaulting the fields the bridge keeps constant. */
function makeSpan(fields: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
}): OtlpSpan {
  return { ...fields, kind: SPAN_KIND_INTERNAL, status: {} };
}

/**
 * The root span for a closed conversation. A conversation whose start was
 * never captured has no honest start bound, so it yields no root span; its
 * children render as a rootless trace.
 */
function toSessionSpan(row: SessionSpanRow): OtlpSpan | null {
  if (row.startedAt === null) return null;
  const attributes = [stringAttr("harness", row.harness)];
  if (row.model !== null) {
    attributes.push(stringAttr("model", row.model));
  }
  return makeSpan({
    traceId: row.traceId,
    spanId: sessionSpanId(row.sessionId),
    name: "session",
    startTimeUnixNano: toUnixNano(row.startedAt),
    endTimeUnixNano: toUnixNano(row.endedAt),
    attributes,
  });
}

/** A tool span for a closed tool call, parented to its session's root span. */
function toToolSpan(row: ToolSpanRow): OtlpSpan {
  const attributes = [
    stringAttr("harness", row.harness),
    stringAttr("tool_name", row.toolName),
    stringAttr("tool_call_id", row.toolCallId),
  ];
  return makeSpan({
    traceId: row.traceId,
    spanId: mintSpanId(`tool:${row.sessionId}:${row.toolCallId}`),
    parentSpanId: sessionSpanId(row.sessionId),
    name: `tool:${row.toolName}`,
    startTimeUnixNano: toUnixNano(row.startedAt),
    endTimeUnixNano: toUnixNano(row.endedAt),
    attributes,
  });
}

/**
 * A zero-duration span for a point event (`user_prompt`, `compaction`). It
 * parents to the deterministic session span id whether or not that root span
 * exists yet: an unfinished session renders rootless.
 */
function toPointSpan(event: LogRow): OtlpSpan {
  const at = toUnixNano(event.timestamp);
  const attributes = [stringAttr("harness", event.harness)];
  for (const [key, value] of Object.entries(event.attributes)) {
    attributes.push(stringAttr(key, value));
  }
  return makeSpan({
    traceId: event.traceId,
    spanId: mintSpanId(`point:${event.eventHash}`),
    parentSpanId: sessionSpanId(event.sessionId),
    name: event.spanName,
    startTimeUnixNano: at,
    endTimeUnixNano: at,
    attributes,
  });
}

/** Shape a traces batch into one OTLP `TracesData` message. */
export function projectTraces(
  batch: TracesBatch,
  options: ProjectionOptions,
): TracesData {
  const spans: OtlpSpan[] = [];
  for (const row of batch.sessionSpans) {
    const span = toSessionSpan(row);
    if (span !== null) spans.push(span);
  }
  for (const row of batch.toolSpans) {
    spans.push(toToolSpan(row));
  }
  for (const event of batch.pointEvents) {
    spans.push(toPointSpan(event));
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(options) },
        scopeSpans: [
          {
            scope: { name: options.scopeName, version: options.scopeVersion },
            spans,
          },
        ],
      },
    ],
  };
}
