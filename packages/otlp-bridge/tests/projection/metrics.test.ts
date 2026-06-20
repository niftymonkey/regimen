import { test, expect } from "bun:test";
import { projectMetrics } from "../../src/projection/metrics.ts";
import type { ProjectionOptions } from "../../src/projection/resource.ts";
import type {
  ConversationCountsRow,
  MetricsBatch,
} from "../../src/source/types.ts";
import {
  AGGREGATION_TEMPORALITY_CUMULATIVE,
  toUnixNano,
} from "../../src/otlp.ts";

const OPTIONS: ProjectionOptions = {
  serviceName: "regimen",
  serviceVersion: "0.0.0",
  environment: "test",
  scopeName: "regimen-otlp-bridge",
  scopeVersion: "0.0.0",
};

/** The time the batch was observed; stamps every metric data point. */
const OBSERVED_AT = "2026-05-21T22:35:00.000Z";

function counts(
  partial: Partial<ConversationCountsRow> = {},
): ConversationCountsRow {
  return {
    sessionId: "sess-1",
    harness: "claude",
    model: null,
    promptCount: 0,
    toolCallCount: 0,
    compactionCount: 0,
    gateDenialCount: 0,
    lastEventAt: "2026-05-21T12:00:00.000Z",
    ...partial,
  };
}

function emptyBatch(partial: Partial<MetricsBatch> = {}): MetricsBatch {
  return {
    counts: [],
    fileEdits: [],
    gateDenials: [],
    nextWatermark: null,
    ...partial,
  };
}

/** Every metric in a MetricsData, regardless of resource/scope nesting. */
function metricsOf(data: ReturnType<typeof projectMetrics>) {
  return data.resourceMetrics.flatMap((rm) =>
    rm.scopeMetrics.flatMap((sm) => sm.metrics),
  );
}

/** A flat key to string-value map of a data point's attributes. */
function attrMap(
  attributes: { key: string; value: { stringValue?: string } }[],
) {
  return Object.fromEntries(
    attributes.map((a) => [a.key, a.value.stringValue]),
  );
}

test("a conversation's prompt count becomes a cumulative monotonic sum metric", () => {
  const data = projectMetrics(
    emptyBatch({ counts: [counts({ promptCount: 5 })] }),
    OPTIONS,
    OBSERVED_AT,
  );

  const prompts = metricsOf(data).find(
    (m) => m.name === "regimen.conversation.prompts",
  );
  expect(prompts).toBeDefined();
  expect(prompts!.sum!.aggregationTemporality).toBe(
    AGGREGATION_TEMPORALITY_CUMULATIVE,
  );
  expect(prompts!.sum!.isMonotonic).toBe(true);
  expect(prompts!.sum!.dataPoints).toHaveLength(1);
  expect(prompts!.sum!.dataPoints[0]!.asInt).toBe("5");
});

test("a repeated-file-edit row becomes a gauge data point keyed by session and file", () => {
  const data = projectMetrics(
    emptyBatch({
      fileEdits: [
        {
          sessionId: "sess-a",
          harness: "claude",
          filePath: "src/source/source.ts",
          editCount: 4,
          lastEditedAt: "2026-05-21T12:00:05.000Z",
        },
      ],
    }),
    OPTIONS,
    OBSERVED_AT,
  );

  const edits = metricsOf(data).find((m) => m.name === "regimen.file.edits");
  expect(edits).toBeDefined();
  expect(edits!.gauge!.dataPoints).toHaveLength(1);
  expect(edits!.gauge!.dataPoints[0]!.asInt).toBe("4");
  expect(attrMap(edits!.gauge!.dataPoints[0]!.attributes)).toEqual({
    session_id: "sess-a",
    harness: "claude",
    file_path: "src/source/source.ts",
  });
});

test("gate-denial rows become a sum counted per session and gate", () => {
  const data = projectMetrics(
    emptyBatch({
      gateDenials: [
        {
          sessionId: "sess-a",
          harness: "claude",
          gateId: "rm-rf-guard",
          toolName: "Bash",
          deniedAt: "2026-05-21T12:00:01.000Z",
        },
        {
          sessionId: "sess-a",
          harness: "claude",
          gateId: "rm-rf-guard",
          toolName: "Bash",
          deniedAt: "2026-05-21T12:00:09.000Z",
        },
      ],
    }),
    OPTIONS,
    OBSERVED_AT,
  );

  const denials = metricsOf(data).find(
    (m) => m.name === "regimen.gate.denials",
  );
  expect(denials).toBeDefined();
  expect(denials!.sum!.aggregationTemporality).toBe(
    AGGREGATION_TEMPORALITY_CUMULATIVE,
  );
  expect(denials!.sum!.dataPoints).toHaveLength(1);
  expect(denials!.sum!.dataPoints[0]!.asInt).toBe("2");
  expect(attrMap(denials!.sum!.dataPoints[0]!.attributes)).toEqual({
    session_id: "sess-a",
    harness: "claude",
    gate_id: "rm-rf-guard",
  });
});

test("a metric with no data points is omitted entirely, not emitted empty", () => {
  // Grafana's OTLP parser rejects an empty-data-point metric and drops the
  // whole request, so a session with no file edits or denials must yield no
  // file-edit or gate-denial metric at all.
  const data = projectMetrics(
    emptyBatch({ counts: [counts({ promptCount: 1 })] }),
    OPTIONS,
    OBSERVED_AT,
  );

  const names = metricsOf(data).map((m) => m.name);
  expect(names).not.toContain("regimen.file.edits");
  expect(names).not.toContain("regimen.gate.denials");
  for (const metric of metricsOf(data)) {
    const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
    expect(points.length).toBeGreaterThan(0);
  }
});

test("conversation counter data points carry only session, harness, and model labels", () => {
  const data = projectMetrics(
    emptyBatch({
      counts: [
        counts({
          sessionId: "sess-z",
          model: "claude-opus-4-7",
          promptCount: 3,
        }),
      ],
    }),
    OPTIONS,
    OBSERVED_AT,
  );

  const prompts = metricsOf(data).find(
    (m) => m.name === "regimen.conversation.prompts",
  );
  expect(attrMap(prompts!.sum!.dataPoints[0]!.attributes)).toEqual({
    session_id: "sess-z",
    harness: "claude",
    model: "claude-opus-4-7",
  });
});

test("a data point is stamped with the observation time, not the event time", () => {
  // Grafana's metric store rejects samples dated far in the past; the sample
  // time is when the count was read, the cumulative value carries the history.
  const data = projectMetrics(
    emptyBatch({
      counts: [
        counts({ promptCount: 5, lastEventAt: "2026-05-21T08:00:00.000Z" }),
      ],
    }),
    OPTIONS,
    OBSERVED_AT,
  );

  const point = metricsOf(data).find(
    (m) => m.name === "regimen.conversation.prompts",
  )!.sum!.dataPoints[0]!;
  expect(point.timeUnixNano).toBe(toUnixNano(OBSERVED_AT));
});
