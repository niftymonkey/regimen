import { test, expect } from "bun:test";
import { eventsToLogs } from "../../src/projection/logs.ts";
import type { ProjectionOptions } from "../../src/projection/resource.ts";
import type { LogRow } from "../../src/source/types.ts";

const OPTIONS: ProjectionOptions = {
  serviceName: "regimen",
  serviceVersion: "0.0.0",
  environment: "test",
  scopeName: "regimen-otlp-bridge",
  scopeVersion: "0.0.0",
};

const TRACE_ID = "0123456789abcdef0123456789abcdef";

/** Build a LogRow, overriding only the fields a test cares about. */
function row(partial: Partial<LogRow> = {}): LogRow {
  return {
    eventHash: "a".repeat(64),
    schemaVersion: 1,
    traceId: TRACE_ID,
    sessionId: "sess-1",
    timestamp: "2026-05-21T12:00:00.000Z",
    harness: "claude",
    model: null,
    eventType: "user_prompt",
    spanPhase: "point",
    spanName: "user_prompt",
    attributes: {},
    ...partial,
  };
}

/** The log records of a LogsData, regardless of how many resources nest them. */
function recordsOf(data: ReturnType<typeof eventsToLogs>) {
  return data.resourceLogs.flatMap((rl) =>
    rl.scopeLogs.flatMap((sl) => sl.logRecords),
  );
}

/** A flat key to string-value map of a record's or resource's attributes. */
function attrMap(
  attributes: { key: string; value: { stringValue?: string } }[],
) {
  return Object.fromEntries(
    attributes.map((a) => [a.key, a.value.stringValue]),
  );
}

test("one event row becomes one OTLP log record carrying its trace id", () => {
  const data = eventsToLogs([row({ eventType: "session.start" })], OPTIONS);

  const records = recordsOf(data);
  expect(records).toHaveLength(1);
  expect(records[0]!.traceId).toBe(TRACE_ID);
  expect(records[0]!.timeUnixNano).toBe(
    (BigInt(Date.parse("2026-05-21T12:00:00.000Z")) * 1_000_000n).toString(),
  );
});

test("a log record carries session, event type, harness, model, and event attributes", () => {
  const data = eventsToLogs(
    [
      row({
        sessionId: "sess-7",
        eventType: "tool.pre",
        harness: "claude",
        model: "claude-opus-4-7",
        attributes: { tool_name: "Bash", tool_call_id: "tc-1" },
      }),
    ],
    OPTIONS,
  );

  const attrs = attrMap(recordsOf(data)[0]!.attributes);
  expect(attrs["session_id"]).toBe("sess-7");
  expect(attrs["event_type"]).toBe("tool.pre");
  expect(attrs["harness"]).toBe("claude");
  expect(attrs["model"]).toBe("claude-opus-4-7");
  expect(attrs["tool_name"]).toBe("Bash");
  expect(attrs["tool_call_id"]).toBe("tc-1");
});

test("an absent model contributes no attribute, not an empty one", () => {
  const data = eventsToLogs([row({ model: null })], OPTIONS);

  const attrs = attrMap(recordsOf(data)[0]!.attributes);
  expect("model" in attrs).toBe(false);
});

test("the resource carries only the three bounded service attributes", () => {
  const data = eventsToLogs([row()], OPTIONS);

  const attrs = attrMap(data.resourceLogs[0]!.resource.attributes);
  expect(attrs).toEqual({
    "service.name": "regimen",
    "service.version": "0.0.0",
    "deployment.environment": "test",
  });
});
