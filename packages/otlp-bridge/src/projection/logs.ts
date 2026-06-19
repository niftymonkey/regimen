/**
 * Projection: typed event rows to an OTLP `LogsData` message.
 *
 * One log record per event. The trace id rides the record's native `traceId`
 * field so a log correlates to its trace. The session id, event type,
 * harness, and model become record attributes; an absent model contributes no
 * attribute rather than an empty one. The event's own attribute bag is carried
 * through as record attributes too.
 */
import type { LogRow } from "../source/types.ts";
import {
  type KeyValue,
  type LogRecord,
  type LogsData,
  stringAttr,
  toUnixNano,
} from "../otlp.ts";
import { type ProjectionOptions, resourceAttributes } from "./resource.ts";

/**
 * The record attributes for one event. session, event type, and harness are
 * always present; model only when the harness resolved one; the event's own
 * attribute bag (tool_name, gate_id, and so on) is carried through.
 */
function recordAttributes(row: LogRow): KeyValue[] {
  const attributes: KeyValue[] = [
    stringAttr("session_id", row.sessionId),
    stringAttr("event_type", row.eventType),
    stringAttr("harness", row.harness),
  ];
  if (row.model !== null) {
    attributes.push(stringAttr("model", row.model));
  }
  for (const [key, value] of Object.entries(row.attributes)) {
    attributes.push(stringAttr(key, value));
  }
  return attributes;
}

/** Shape a batch of event rows into one OTLP `LogsData` message. */
export function eventsToLogs(
  rows: LogRow[],
  options: ProjectionOptions,
): LogsData {
  const logRecords: LogRecord[] = rows.map((row) => ({
    timeUnixNano: toUnixNano(row.timestamp),
    body: { stringValue: row.eventType },
    attributes: recordAttributes(row),
    traceId: row.traceId,
  }));
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(options) },
        scopeLogs: [
          {
            scope: { name: options.scopeName, version: options.scopeVersion },
            logRecords,
          },
        ],
      },
    ],
  };
}
