/**
 * Minimal OTLP/JSON message types and encoding helpers.
 *
 * This is the protobuf-JSON mapping the OTLP/HTTP endpoints accept: a
 * `TracesData` message of `resourceSpans`, a `LogsData` message of
 * `resourceLogs`, and a `MetricsData` message of `resourceMetrics`. Only the
 * fields the bridge emits are modelled.
 */

import { createHash } from "node:crypto";

/** An OTLP attribute value. The bridge only ever emits string values. */
export interface AnyValue {
  stringValue?: string;
}

export interface KeyValue {
  key: string;
  value: AnyValue;
}

/** SPAN_KIND_INTERNAL. The tracer bullet models sessions, tools, and prompts as internal work. */
export const SPAN_KIND_INTERNAL = 1;

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: Record<string, never>;
}

export interface ScopeSpans {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

export interface ResourceSpans {
  resource: { attributes: KeyValue[] };
  scopeSpans: ScopeSpans[];
}

export interface TracesData {
  resourceSpans: ResourceSpans[];
}

/**
 * One OTLP log record. `traceId` carries the event's trace id so a log
 * correlates to its trace in Grafana; it is the OTLP-native home for the id,
 * never a resource attribute.
 */
export interface LogRecord {
  timeUnixNano: string;
  body: AnyValue;
  attributes: KeyValue[];
  traceId?: string;
}

export interface ScopeLogs {
  scope: { name: string; version: string };
  logRecords: LogRecord[];
}

export interface ResourceLogs {
  resource: { attributes: KeyValue[] };
  scopeLogs: ScopeLogs[];
}

export interface LogsData {
  resourceLogs: ResourceLogs[];
}

/** AGGREGATION_TEMPORALITY_CUMULATIVE: the only temporality Grafana accepts. */
export const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;

/** One metric data point. Integer values are carried as `asInt` per OTLP/JSON. */
export interface NumberDataPoint {
  attributes: KeyValue[];
  timeUnixNano: string;
  asInt: string;
}

/** A monotonic cumulative counter. */
export interface Sum {
  dataPoints: NumberDataPoint[];
  aggregationTemporality: number;
  isMonotonic: boolean;
}

/** A point-in-time value. */
export interface Gauge {
  dataPoints: NumberDataPoint[];
}

export interface Metric {
  name: string;
  sum?: Sum;
  gauge?: Gauge;
}

export interface ScopeMetrics {
  scope: { name: string; version: string };
  metrics: Metric[];
}

export interface ResourceMetrics {
  resource: { attributes: KeyValue[] };
  scopeMetrics: ScopeMetrics[];
}

export interface MetricsData {
  resourceMetrics: ResourceMetrics[];
}

/** Build an OTLP string-valued attribute. */
export function stringAttr(key: string, value: string): KeyValue {
  return { key, value: { stringValue: value } };
}

/**
 * Convert an RFC 3339 UTC timestamp to a Unix-nanoseconds string.
 * Handles fractional seconds of any precision (milli, micro, nano).
 */
export function toUnixNano(timestamp: string): string {
  const match = timestamp.match(/^(.*?)(?:\.(\d+))?Z$/);
  if (!match || match[1] === undefined) {
    throw new Error(`Unparseable timestamp: ${timestamp}`);
  }
  const wholeMs = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(wholeMs)) {
    throw new Error(`Unparseable timestamp: ${timestamp}`);
  }
  let nanos = BigInt(Math.floor(wholeMs / 1000)) * 1_000_000_000n;
  if (match[2]) {
    nanos += BigInt(match[2].padEnd(9, "0").slice(0, 9));
  }
  return nanos.toString();
}

/**
 * Mint a deterministic 16-hex-char (8-byte) span id from a seed.
 * Deterministic so re-projecting the same row yields a stable span id and
 * parent links resolve even across separate daemon runs.
 */
export function mintSpanId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
