/**
 * The bridge's operational logger.
 *
 * The bridge writes `<dataDir>/bridge.log` itself rather than relying on the
 * service supervisor to redirect its stdout, so it can keep that file bounded
 * the way the Feedback loader bounds its own log. The log is a plain,
 * greppable operational record: one line per entry, `<rfc3339> <kind> <k=v>`.
 *
 * Routine per-tick deliveries do not each get a line. `tick` and `delivered`
 * fold into an in-memory aggregate; a periodic `heartbeat` emits one summary
 * line per window. Lifecycle, the transition into and out of a failing
 * stream, and anomalies are logged as they happen, so the failures worth
 * acting on stand out rather than being buried under routine success lines.
 *
 * The file is rolled once it reaches a byte cap, so it stays bounded across
 * the daemon's whole lifetime. Every sink is best-effort: a file-system
 * failure is swallowed and counted, never thrown, so a logging failure
 * cannot crash the bridge it observes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { rollIfOversize } from "./rolling-log.ts";
import type { SignalStream } from "./state/watermarks.ts";

/** The slice of the operational log the daemon's poll loop reports into. */
export interface DaemonLog {
  /** Record that a poll cycle ran. Folded into the heartbeat. */
  tick(): void;
  /** Record a delivery of `records` items on `stream`. Folded into the heartbeat. */
  delivered(stream: SignalStream, records: number): void;
  /** Record a failed delivery on `stream`, with the delivery's error text. */
  sendFailed(stream: SignalStream, error: string): void;
  /** Record a caught anomaly, with a short `context` and the error. */
  anomaly(context: string, err: unknown): void;
}

/** The full operational log: the daemon-facing slice plus process lifecycle. */
export interface OperationalLog extends DaemonLog {
  /** Record that the bridge has started streaming from `db`. */
  started(db: string): void;
  /** Record that the bridge is shutting down, with the triggering reason. */
  shutdown(reason: string): void;
  /** Emit the aggregated heartbeat line now and reset the window. */
  heartbeat(): void;
  /** Flush a pending heartbeat and stop the timer. Idempotent. */
  close(): void;
}

export interface OperationalLogConfig {
  /** Absolute path to the log file the bridge owns and rolls. */
  readonly logPath: string;
  /** Heartbeat emission cadence in milliseconds. Default 600_000 (10 min). */
  readonly heartbeatMs?: number;
  /** Roll the log once it reaches this size. Default 1_000_000. */
  readonly maxBytes?: number;
  /** Rolled copies of the log to retain. Default 3. */
  readonly keep?: number;
  /** Injectable clock; default `Date.now`. The one internal seam. */
  readonly now?: () => number;
}

/** The three OTLP streams, for emitting heartbeat fields in a stable order. */
const STREAMS: readonly SignalStream[] = ["logs", "metrics", "traces"];

/** One stream's routine activity within a heartbeat window. */
interface StreamTotals {
  /** Records (log records, metric points, or spans) delivered this window. */
  records: number;
  /** Failed delivery attempts this window. */
  failures: number;
}

/** Routine per-tick activity, accumulated for one heartbeat window. */
interface Aggregate {
  windowStart: number;
  ticks: number;
  /** Best-effort writes swallowed in this window; rides the next heartbeat. */
  writeFailures: number;
  streams: Record<SignalStream, StreamTotals>;
}

function emptyAggregate(windowStart: number): Aggregate {
  return {
    windowStart,
    ticks: 0,
    writeFailures: 0,
    streams: {
      logs: { records: 0, failures: 0 },
      metrics: { records: 0, failures: 0 },
      traces: { records: 0, failures: 0 },
    },
  };
}

/** Render any caught value as one line, embedded newlines escaped. */
function describeError(err: unknown): string {
  const text =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  return text.replace(/\r?\n/g, "\\n");
}

// The immediate-event line formats, shared by the rolling file logger and
// the dry-run console logger so the two cannot drift apart.

function startedLine(ts: string, db: string): string {
  return `${ts} started pid=${process.pid} db="${db}"`;
}

function shutdownLine(ts: string, reason: string): string {
  return `${ts} shutdown reason=${reason}`;
}

function sendFailedLine(
  ts: string,
  stream: SignalStream,
  error: string,
): string {
  return `${ts} send-failed stream=${stream} error=${describeError(error)}`;
}

function anomalyLine(ts: string, context: string, err: unknown): string {
  return `${ts} anomaly context="${context}" error=${describeError(err)}`;
}

/**
 * Open the operational logger for the `bridge.log` at `config.logPath`. The
 * returned handle must be `close`d on shutdown so the heartbeat timer stops.
 */
export function openOperationalLog(
  config: OperationalLogConfig,
): OperationalLog {
  const now = config.now ?? Date.now;
  const heartbeatMs = config.heartbeatMs ?? 600_000;
  const maxBytes = config.maxBytes ?? 1_000_000;
  const keep = config.keep ?? 3;
  const logPath = config.logPath;

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // The data directory normally exists already; a failure here resurfaces
    // as a swallowed write failure on the first append.
  }

  const stamp = (): string => new Date(now()).toISOString();

  let aggregate = emptyAggregate(now());

  // Best-effort: a file-system failure is swallowed and counted, never
  // thrown, so a logging failure cannot crash the bridge it observes. The
  // window's count rides along on the next heartbeat line.
  const append = (line: string): void => {
    try {
      const outcome = rollIfOversize(logPath, { maxBytes, keep });
      if (outcome.rolled) {
        appendFileSync(logPath, `${stamp()} log-rolled\n`);
      }
      appendFileSync(logPath, `${line}\n`);
    } catch {
      aggregate.writeFailures += 1;
    }
  };
  // Whether each stream's last delivery attempt failed. Persists across
  // heartbeat windows so a stuck stream logs one line, not one per tick.
  const failing: Record<SignalStream, boolean> = {
    logs: false,
    metrics: false,
    traces: false,
  };

  const heartbeat = (): void => {
    const { streams } = aggregate;
    const fields = [
      `window_ms=${now() - aggregate.windowStart}`,
      `ticks=${aggregate.ticks}`,
      `logs=${streams.logs.records}`,
      `metrics=${streams.metrics.records}`,
      `traces=${streams.traces.records}`,
    ];
    for (const stream of STREAMS) {
      if (streams[stream].failures > 0) {
        fields.push(`${stream}_failed=${streams[stream].failures}`);
      }
    }
    if (aggregate.writeFailures > 0) {
      fields.push(`write_failures=${aggregate.writeFailures}`);
    }
    append(`${stamp()} heartbeat ${fields.join(" ")}`);
    aggregate = emptyAggregate(now());
  };

  // The timer keeps the heartbeat cadence; `unref` so it never holds the
  // process open on its own.
  const interval = setInterval(heartbeat, heartbeatMs);
  interval.unref();
  let closed = false;

  return {
    started(db: string): void {
      append(startedLine(stamp(), db));
    },
    shutdown(reason: string): void {
      append(shutdownLine(stamp(), reason));
    },
    tick(): void {
      aggregate.ticks += 1;
    },
    delivered(stream: SignalStream, records: number): void {
      aggregate.streams[stream].records += records;
      if (failing[stream]) {
        failing[stream] = false;
        append(`${stamp()} recovered stream=${stream}`);
      }
    },
    sendFailed(stream: SignalStream, error: string): void {
      aggregate.streams[stream].failures += 1;
      if (!failing[stream]) {
        failing[stream] = true;
        append(sendFailedLine(stamp(), stream, error));
      }
    },
    anomaly(context: string, err: unknown): void {
      append(anomalyLine(stamp(), context, err));
    },
    heartbeat,
    close(): void {
      if (closed) return;
      clearInterval(interval);
      if (aggregate.ticks > 0) heartbeat();
      closed = true;
    },
  };
}

/**
 * An operational log that writes each event straight to the console, with no
 * heartbeat folding and no file. A dry run uses it: a foreground preview
 * shows every event as it happens and writes no `bridge.log`. Routine
 * per-tick activity (`tick`, `delivered`) is dropped, since a dry run already
 * reports per-payload counts through its exporter.
 */
export function consoleLog(): OperationalLog {
  const stamp = (): string => new Date().toISOString();
  const line = (text: string): void => {
    console.error(text);
  };
  return {
    started(db: string): void {
      line(startedLine(stamp(), db));
    },
    shutdown(reason: string): void {
      line(shutdownLine(stamp(), reason));
    },
    tick(): void {},
    delivered(): void {},
    sendFailed(stream: SignalStream, error: string): void {
      line(sendFailedLine(stamp(), stream, error));
    },
    anomaly(context: string, err: unknown): void {
      line(anomalyLine(stamp(), context, err));
    },
    heartbeat(): void {},
    close(): void {},
  };
}
