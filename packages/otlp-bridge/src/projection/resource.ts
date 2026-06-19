/**
 * Shared projection inputs: the resource identity every OTLP signal carries.
 *
 * The resource attributes are bounded values only (`service.name`,
 * `service.version`, `deployment.environment`). Per-event identifiers
 * (trace_id, session_id, tool_call_id) are never resource attributes; they
 * stay on the individual record or span, so they do not become high-
 * cardinality stream labels in Grafana.
 */
import { type KeyValue, stringAttr } from "../otlp.ts";

export interface ProjectionOptions {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  scopeName: string;
  scopeVersion: string;
}

/** The bounded resource attributes shared by every emitted signal. */
export function resourceAttributes(options: ProjectionOptions): KeyValue[] {
  return [
    stringAttr("service.name", options.serviceName),
    stringAttr("service.version", options.serviceVersion),
    stringAttr("deployment.environment", options.environment),
  ];
}
