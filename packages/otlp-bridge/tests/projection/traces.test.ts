import { test, expect } from "bun:test";
import { projectTraces } from "../../src/projection/traces.ts";
import type { ProjectionOptions } from "../../src/projection/resource.ts";
import type {
  LogRow,
  SessionSpanRow,
  ToolSpanRow,
  TracesBatch,
} from "../../src/source/types.ts";
import { mintSpanId } from "../../src/otlp.ts";

const OPTIONS: ProjectionOptions = {
  serviceName: "regimen",
  serviceVersion: "0.0.0",
  environment: "test",
  scopeName: "regimen-otlp-bridge",
  scopeVersion: "0.0.0",
};

const TRACE_ID = "0123456789abcdef0123456789abcdef";

function emptyBatch(partial: Partial<TracesBatch> = {}): TracesBatch {
  return {
    sessionSpans: [],
    toolSpans: [],
    pointEvents: [],
    nextWatermark: null,
    ...partial,
  };
}

function sessionSpan(partial: Partial<SessionSpanRow> = {}): SessionSpanRow {
  return {
    sessionId: "sess-1",
    traceId: TRACE_ID,
    harness: "claude",
    model: null,
    startedAt: "2026-05-21T12:00:00.000Z",
    endedAt: "2026-05-21T12:30:00.000Z",
    ...partial,
  };
}

function toolSpan(partial: Partial<ToolSpanRow> = {}): ToolSpanRow {
  return {
    sessionId: "sess-1",
    traceId: TRACE_ID,
    harness: "claude",
    toolName: "Bash",
    toolCallId: "tc-1",
    startedAt: "2026-05-21T12:01:00.000Z",
    endedAt: "2026-05-21T12:01:02.000Z",
    durationMs: 2000,
    deniedByGateId: null,
    ...partial,
  };
}

function pointEvent(partial: Partial<LogRow> = {}): LogRow {
  return {
    eventHash: "a".repeat(64),
    schemaVersion: 1,
    traceId: TRACE_ID,
    sessionId: "sess-1",
    timestamp: "2026-05-21T12:02:00.000Z",
    harness: "claude",
    model: null,
    eventType: "user_prompt",
    spanPhase: "point",
    spanName: "user_prompt",
    attributes: {},
    ...partial,
  };
}

/** Every span in a TracesData, regardless of resource/scope nesting. */
function spansOf(data: ReturnType<typeof projectTraces>) {
  return data.resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) => ss.spans),
  );
}

/** A flat key to string-value map of a span's or resource's attributes. */
function attrMap(
  attributes: { key: string; value: { stringValue?: string } }[],
) {
  return Object.fromEntries(
    attributes.map((a) => [a.key, a.value.stringValue]),
  );
}

const nanos = (ts: string): string =>
  (BigInt(Date.parse(ts)) * 1_000_000n).toString();

test("a closed conversation becomes a root session span", () => {
  const data = projectTraces(
    emptyBatch({ sessionSpans: [sessionSpan()] }),
    OPTIONS,
  );

  const spans = spansOf(data);
  expect(spans).toHaveLength(1);
  expect(spans[0]!.name).toBe("session");
  expect(spans[0]!.traceId).toBe(TRACE_ID);
  expect(spans[0]!.spanId).toBe(mintSpanId("session:sess-1"));
  expect(spans[0]!.parentSpanId).toBeUndefined();
  expect(spans[0]!.startTimeUnixNano).toBe(nanos("2026-05-21T12:00:00.000Z"));
  expect(spans[0]!.endTimeUnixNano).toBe(nanos("2026-05-21T12:30:00.000Z"));
});

test("a closed tool call becomes a tool span parented to its session", () => {
  const data = projectTraces(
    emptyBatch({
      toolSpans: [toolSpan({ toolName: "Edit", toolCallId: "tc-7" })],
    }),
    OPTIONS,
  );

  const span = spansOf(data).find((s) => s.name === "tool:Edit")!;
  expect(span).toBeDefined();
  expect(span.traceId).toBe(TRACE_ID);
  expect(span.parentSpanId).toBe(mintSpanId("session:sess-1"));
  expect(span.startTimeUnixNano).toBe(nanos("2026-05-21T12:01:00.000Z"));
  expect(span.endTimeUnixNano).toBe(nanos("2026-05-21T12:01:02.000Z"));
});

test("a point event becomes a zero-duration span parented to its session", () => {
  const data = projectTraces(
    emptyBatch({
      pointEvents: [
        pointEvent({
          eventType: "user_prompt",
          spanName: "user_prompt",
          timestamp: "2026-05-21T12:02:00.000Z",
        }),
      ],
    }),
    OPTIONS,
  );

  const span = spansOf(data).find((s) => s.name === "user_prompt")!;
  expect(span).toBeDefined();
  expect(span.parentSpanId).toBe(mintSpanId("session:sess-1"));
  expect(span.startTimeUnixNano).toBe(nanos("2026-05-21T12:02:00.000Z"));
  expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);
});

test("a tool span carries its tool name and call id", () => {
  const data = projectTraces(
    emptyBatch({
      toolSpans: [toolSpan({ toolName: "Bash", toolCallId: "tc-3" })],
    }),
    OPTIONS,
  );

  const attrs = attrMap(spansOf(data)[0]!.attributes);
  expect(attrs["tool_name"]).toBe("Bash");
  expect(attrs["tool_call_id"]).toBe("tc-3");
});

test("a tool call denied by a gate carries the deciding gate id", () => {
  const data = projectTraces(
    emptyBatch({ toolSpans: [toolSpan({ deniedByGateId: "rm-rf-guard" })] }),
    OPTIONS,
  );

  expect(attrMap(spansOf(data)[0]!.attributes)["gate_id"]).toBe("rm-rf-guard");
});

test("a gate.denial point event carries the gate detail from its attributes", () => {
  const data = projectTraces(
    emptyBatch({
      pointEvents: [
        pointEvent({
          eventType: "gate.denial",
          spanName: "gate:rm-rf-guard",
          attributes: {
            gate_id: "rm-rf-guard",
            tool_name: "Bash",
            tool_call_id: "tc-9",
            reason: "recursive forced rm denied",
          },
        }),
      ],
    }),
    OPTIONS,
  );

  const attrs = attrMap(spansOf(data)[0]!.attributes);
  expect(attrs["gate_id"]).toBe("rm-rf-guard");
  expect(attrs["tool_name"]).toBe("Bash");
  expect(attrs["reason"]).toBe("recursive forced rm denied");
});

test("a compaction point event becomes a zero-duration span", () => {
  const data = projectTraces(
    emptyBatch({
      pointEvents: [
        pointEvent({ eventType: "compaction", spanName: "compaction" }),
      ],
    }),
    OPTIONS,
  );

  const span = spansOf(data).find((s) => s.name === "compaction")!;
  expect(span).toBeDefined();
  expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
});

test("every span carries the harness attribute", () => {
  const data = projectTraces(
    emptyBatch({
      sessionSpans: [sessionSpan()],
      toolSpans: [toolSpan()],
      pointEvents: [pointEvent()],
    }),
    OPTIONS,
  );

  const spans = spansOf(data);
  expect(spans).toHaveLength(3);
  for (const span of spans) {
    expect(attrMap(span.attributes)["harness"]).toBe("claude");
  }
});

test("point events for a session with no session span still emit, rootless", () => {
  // The Source skips an open conversation, so no session span row arrives.
  // The point span still emits and parents to the absent root: a rootless
  // trace is the honest representation of an unfinished session.
  const data = projectTraces(
    emptyBatch({ pointEvents: [pointEvent({ eventType: "user_prompt" })] }),
    OPTIONS,
  );

  const spans = spansOf(data);
  expect(spans).toHaveLength(1);
  expect(spans[0]!.name).toBe("user_prompt");
  expect(spans.find((s) => s.name === "session")).toBeUndefined();
  expect(spans[0]!.parentSpanId).toBe(mintSpanId("session:sess-1"));
});

test("a closed conversation whose start was never captured yields no root span", () => {
  const data = projectTraces(
    emptyBatch({ sessionSpans: [sessionSpan({ startedAt: null })] }),
    OPTIONS,
  );

  expect(spansOf(data)).toHaveLength(0);
});

test("the resource carries only the three bounded service attributes", () => {
  const data = projectTraces(
    emptyBatch({ sessionSpans: [sessionSpan()] }),
    OPTIONS,
  );

  expect(attrMap(data.resourceSpans[0]!.resource.attributes)).toEqual({
    "service.name": "regimen",
    "service.version": "0.0.0",
    "deployment.environment": "test",
  });
});
