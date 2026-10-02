/**
 * The live Exporter adapter: delivers OTLP/JSON over HTTP to Grafana Cloud.
 *
 * Grafana Cloud exposes one OTLP base endpoint; the three signals post to its
 * `/v1/logs`, `/v1/metrics`, and `/v1/traces` paths. A failed send reports
 * `ok: false`; the daemon then leaves that stream's watermark unadvanced and
 * retries on the next tick, so the poll loop is itself the retry mechanism.
 *
 * A 400 is the exception: the endpoint refused the payload itself (Grafana
 * Cloud answers 400 to log entries older than its ingestion window), so the
 * send reports `rejected` and the daemon drops the batch. Every other status
 * stays retryable. Auth failures in particular must never read as rejected,
 * or a bad token would drain the whole backlog into nothing.
 */
import type { Exporter, OtlpPayload, SendResult } from "./port.ts";

/**
 * How long one delivery may take before it is abandoned. Without a bound a
 * hung connection would stall the daemon's poll loop indefinitely; an abort
 * surfaces as a failed send, which the next tick retries.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export interface HttpExporterConfig {
  /** The Grafana Cloud OTLP base endpoint, e.g. `https://.../otlp`. */
  endpoint: string;
  /** The full `Authorization` header value, e.g. `Basic <base64>`. */
  authHeader: string;
}

/**
 * How much of a response body an error carries. Grafana Cloud can answer a
 * rejected batch with one line per refused entry, which would otherwise put
 * a body of a hundred kilobytes or more into `bridge.log` per failure.
 */
const MAX_ERROR_BODY_CHARS = 500;

function clipBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY_CHARS) return body;
  return `${body.slice(0, MAX_ERROR_BODY_CHARS)}... (${body.length} chars in all)`;
}

const SIGNAL_PATHS: Record<OtlpPayload["stream"], string> = {
  logs: "/v1/logs",
  metrics: "/v1/metrics",
  traces: "/v1/traces",
};

/** An Exporter that posts OTLP/JSON to Grafana Cloud. */
export function httpExporter(config: HttpExporterConfig): Exporter {
  const base = config.endpoint.replace(/\/+$/, "");
  return {
    async send(payload: OtlpPayload): Promise<SendResult> {
      const url = `${base}${SIGNAL_PATHS[payload.stream]}`;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: config.authHeader,
          },
          body: JSON.stringify(payload.data),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return { ok: true };
        // The status alone decides whether the payload was rejected, so a
        // body that cannot be read must not turn a 400 into a retryable error.
        let body: string;
        try {
          body = clipBody(await response.text());
        } catch (cause) {
          body = `(unreadable body: ${String(cause)})`;
        }
        const error = `HTTP ${response.status} from ${url}: ${body}`;
        if (response.status === 400)
          return { ok: false, error, rejected: true };
        return { ok: false, error };
      } catch (cause) {
        return {
          ok: false,
          error: `${payload.stream} send failed: ${String(cause)}`,
        };
      }
    },
  };
}
