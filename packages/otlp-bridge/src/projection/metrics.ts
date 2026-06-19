/**
 * Projection: a metrics batch to an OTLP `MetricsData` message.
 *
 * Every counter is a cumulative monotonic sum (Grafana's metric store rejects
 * delta temporality) and every series is keyed per session, so re-emitting a
 * conversation on watermark overlap reports the same total, not a double
 * count. File edits and gate denials surface only as the rows that exist; a
 * session that had none contributes no data point, never a fabricated zero.
 *
 * Every data point is stamped with the observation time, not the underlying
 * event time. A metric sample's timestamp is when the count was read; the
 * cumulative value carries the history. Grafana's metric store rejects samples
 * dated far in the past, so a sample for a conversation last active hours ago
 * is still timestamped now.
 *
 * A metric with no data points is omitted entirely: Grafana's OTLP parser
 * rejects an empty-data-point metric and drops the whole request with it.
 */
import type {
  ConversationCountsRow,
  FileEditRow,
  GateDenialRow,
  MetricsBatch,
} from "../source/types.ts";
import {
  AGGREGATION_TEMPORALITY_CUMULATIVE,
  type KeyValue,
  type Metric,
  type MetricsData,
  type NumberDataPoint,
  stringAttr,
  toUnixNano,
} from "../otlp.ts";
import { type ProjectionOptions, resourceAttributes } from "./resource.ts";

/** The low-cardinality session labels every metric data point carries. */
function sessionLabels(
  sessionId: string,
  harness: string,
  model: string | null,
): KeyValue[] {
  const labels = [
    stringAttr("session_id", sessionId),
    stringAttr("harness", harness),
  ];
  if (model !== null) {
    labels.push(stringAttr("model", model));
  }
  return labels;
}

/** One cumulative monotonic sum, one data point per conversation. */
function conversationCounter(
  name: string,
  rows: ConversationCountsRow[],
  observedAtNano: string,
  value: (row: ConversationCountsRow) => number,
): Metric {
  const dataPoints: NumberDataPoint[] = rows.map((row) => ({
    attributes: sessionLabels(row.sessionId, row.harness, row.model),
    timeUnixNano: observedAtNano,
    asInt: String(value(row)),
  }));
  return {
    name,
    sum: {
      dataPoints,
      aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
      isMonotonic: true,
    },
  };
}

/** A gauge data point per (session, file): the current edit churn on a file. */
function fileEditsGauge(rows: FileEditRow[], observedAtNano: string): Metric {
  const dataPoints: NumberDataPoint[] = rows.map((row) => ({
    attributes: [
      stringAttr("session_id", row.sessionId),
      stringAttr("harness", row.harness),
      stringAttr("file_path", row.filePath),
    ],
    timeUnixNano: observedAtNano,
    asInt: String(row.editCount),
  }));
  return { name: "regimen.file.edits", gauge: { dataPoints } };
}

/** One denial-count series per (session, gate); the row count is the value. */
interface DenialGroup {
  sessionId: string;
  harness: string;
  gateId: string;
  count: number;
}

function gateDenialsCounter(
  rows: GateDenialRow[],
  observedAtNano: string,
): Metric {
  const groups = new Map<string, DenialGroup>();
  for (const row of rows) {
    // JSON-encode the pair so a space in a free-form gate id cannot collide
    // two distinct (session, gate) groups into one key.
    const key = JSON.stringify([row.sessionId, row.gateId]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        sessionId: row.sessionId,
        harness: row.harness,
        gateId: row.gateId,
        count: 1,
      });
    } else {
      group.count += 1;
    }
  }
  const dataPoints: NumberDataPoint[] = [...groups.values()].map((group) => ({
    attributes: [
      stringAttr("session_id", group.sessionId),
      stringAttr("harness", group.harness),
      stringAttr("gate_id", group.gateId),
    ],
    timeUnixNano: observedAtNano,
    asInt: String(group.count),
  }));
  return {
    name: "regimen.gate.denials",
    sum: {
      dataPoints,
      aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
      isMonotonic: true,
    },
  };
}

/** Whether a metric carries at least one data point. */
function hasDataPoints(metric: Metric): boolean {
  return (
    (metric.sum?.dataPoints.length ?? metric.gauge?.dataPoints.length ?? 0) > 0
  );
}

/**
 * Shape a metrics batch into one OTLP `MetricsData` message. `observedAt` is
 * the RFC 3339 time the batch was read; it stamps every data point.
 */
export function projectMetrics(
  batch: MetricsBatch,
  options: ProjectionOptions,
  observedAt: string,
): MetricsData {
  const at = toUnixNano(observedAt);
  const metrics: Metric[] = [
    conversationCounter(
      "regimen.conversation.prompts",
      batch.counts,
      at,
      (r) => r.promptCount,
    ),
    conversationCounter(
      "regimen.conversation.tool_calls",
      batch.counts,
      at,
      (r) => r.toolCallCount,
    ),
    conversationCounter(
      "regimen.conversation.compactions",
      batch.counts,
      at,
      (r) => r.compactionCount,
    ),
    conversationCounter(
      "regimen.conversation.gate_denials",
      batch.counts,
      at,
      (r) => r.gateDenialCount,
    ),
    fileEditsGauge(batch.fileEdits, at),
    gateDenialsCounter(batch.gateDenials, at),
  ];
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(options) },
        scopeMetrics: [
          {
            scope: { name: options.scopeName, version: options.scopeVersion },
            metrics: metrics.filter(hasDataPoints),
          },
        ],
      },
    ],
  };
}
