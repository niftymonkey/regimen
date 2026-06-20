/**
 * The Exporter port: how the daemon hands an OTLP payload to delivery.
 *
 * Grafana Cloud is a true external dependency, so this is a real seam with
 * two adapters: the live OTLP/HTTP adapter and a recording adapter for tests.
 * The daemon advances a stream's watermark only after `send` reports `ok`, so
 * a failed delivery is retried on the next tick rather than lost.
 */
import type { LogsData, MetricsData, TracesData } from "../otlp.ts";

/** An OTLP message tagged with the signal stream it belongs to. */
export type OtlpPayload =
  | { stream: "logs"; data: LogsData }
  | { stream: "metrics"; data: MetricsData }
  | { stream: "traces"; data: TracesData };

/** The outcome of one delivery attempt. */
export type SendResult = { ok: true } | { ok: false; error: string };

export interface Exporter {
  /** Deliver one OTLP payload; `ok` gates whether its watermark advances. */
  send(payload: OtlpPayload): Promise<SendResult>;
}

/**
 * The number of individual records a payload carries: log records for the
 * logs stream, data points for metrics, spans for traces. The daemon reports
 * this as delivered volume; the dry-run CLI uses it to summarize a payload.
 */
export function payloadSize(payload: OtlpPayload): number {
  if (payload.stream === "logs") {
    return payload.data.resourceLogs.reduce(
      (sum, rl) =>
        sum + rl.scopeLogs.reduce((s, sl) => s + sl.logRecords.length, 0),
      0,
    );
  }
  if (payload.stream === "traces") {
    return payload.data.resourceSpans.reduce(
      (sum, rs) =>
        sum + rs.scopeSpans.reduce((s, ss) => s + ss.spans.length, 0),
      0,
    );
  }
  return payload.data.resourceMetrics.reduce(
    (sum, rm) =>
      sum + rm.scopeMetrics.reduce((s, sm) => s + sm.metrics.length, 0),
    0,
  );
}
