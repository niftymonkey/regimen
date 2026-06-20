/**
 * The live Exporter adapter: delivers OTLP/JSON over HTTP to Grafana Cloud.
 *
 * Grafana Cloud exposes one OTLP base endpoint; the three signals post to its
 * `/v1/logs`, `/v1/metrics`, and `/v1/traces` paths. A failed send reports
 * `ok: false`; the daemon then leaves that stream's watermark unadvanced and
 * retries on the next tick, so the poll loop is itself the retry mechanism.
 *
 * This adapter has no automated test; it is exercised only by a real run
 * against Grafana Cloud. The recording adapter covers the port shape.
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
        return {
          ok: false,
          error: `HTTP ${response.status} from ${url}: ${await response.text()}`,
        };
      } catch (cause) {
        return {
          ok: false,
          error: `${payload.stream} send failed: ${String(cause)}`,
        };
      }
    },
  };
}
