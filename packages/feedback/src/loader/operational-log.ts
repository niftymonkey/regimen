/**
 * The Feedback loader's operational logger.
 *
 * The daemon writes `<dataDir>/daemon.log` itself, rather than relying on the
 * OS service supervisor to redirect its stdout, so it can keep that file
 * bounded the way it already bounds the event buffer. The log is a plain,
 * greppable operational record: one line per entry, `<rfc3339> <kind> <k=v>`.
 *
 * Routine drain activity does not get a line each. `drain` folds every
 * `DrainResult` into an in-memory aggregate; a periodic `heartbeat` emits one
 * summary line per window. Lifecycle, buffer rotations, quarantines, and
 * anomalies are logged as they happen. The logger owns the heartbeat interval
 * timer and the aggregate; `heartbeat` is also public so a caller can flush
 * deterministically without waiting on the timer.
 *
 * Every sink is best-effort: a file-system failure is swallowed and counted,
 * never thrown, so a logging failure cannot crash the daemon it observes. The
 * running count of swallowed failures rides along on the next heartbeat line.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { rollIfOversize } from "../rolling-log.ts";
import type { DrainResult } from "./drain.ts";

export interface OperationalLogConfig {
  /** The Regimen data directory; `daemon.log` is written directly inside it. */
  readonly dataDir: string;
  /** Heartbeat emission cadence in milliseconds. Default 600_000 (10 min). */
  readonly heartbeatMs?: number;
  /** Roll `daemon.log` once it reaches this size. Default 1_000_000. */
  readonly maxBytes?: number;
  /** Rolled copies of `daemon.log` to retain. Default 3. */
  readonly keep?: number;
  /** Injectable clock; default `Date.now`. The one internal seam. */
  readonly now?: () => number;
}

/**
 * The daemon's operational logger. Every method is a best-effort sink that
 * never throws. `drain` accumulates silently; the lifecycle, anomaly, and
 * heartbeat sinks each write a line.
 */
export interface OperationalLog {
  /** Record that the daemon process has started. */
  started(): void;
  /** Record that the buffer watcher is ready. */
  ready(): void;
  /** Record that the daemon is shutting down, with the triggering reason. */
  shutdown(reason: string): void;
  /** Fold one drain into the heartbeat aggregate. Writes no line. */
  drain(result: DrainResult): void;
  /** Record that a drain quarantined `count` malformed lines. */
  quarantined(count: number): void;
  /** Record that the buffer sealed a segment at path `sealed`. */
  rotated(sealed: string): void;
  /** Record a caught anomaly, with a short `context` and the error. */
  anomaly(context: string, err: unknown): void;
  /** Emit the aggregated heartbeat line now and reset the window. */
  heartbeat(): void;
  /** Flush a pending heartbeat and stop the timer. Idempotent. */
  close(): void;
}

interface Aggregate {
  windowStart: number;
  drains: number;
  segments_read: number;
  lines_read: number;
  events_inserted: number;
  events_already_present: number;
  events_skipped: number;
  quarantined: number;
}

function emptyAggregate(windowStart: number): Aggregate {
  return {
    windowStart,
    drains: 0,
    segments_read: 0,
    lines_read: 0,
    events_inserted: 0,
    events_already_present: 0,
    events_skipped: 0,
    quarantined: 0,
  };
}

/** A one-line rendering of any caught value, embedded newlines escaped. */
function describeError(err: unknown): string {
  const text =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  return text.replace(/\r?\n/g, "\\n");
}

/**
 * Open the operational logger for `daemon.log` under `config.dataDir`. The
 * returned handle must be `close`d on shutdown so the heartbeat timer stops
 * and any pending drain activity is flushed.
 */
export function openOperationalLog(
  config: OperationalLogConfig,
): OperationalLog {
  const heartbeatMs = config.heartbeatMs ?? 600_000;
  const maxBytes = config.maxBytes ?? 1_000_000;
  const keep = config.keep ?? 3;
  const now = config.now ?? Date.now;
  const logPath = join(config.dataDir, "daemon.log");

  try {
    mkdirSync(config.dataDir, { recursive: true });
  } catch {
    // The data dir normally exists already; a failure here resurfaces as a
    // swallowed write failure on the first append.
  }

  let aggregate = emptyAggregate(now());
  let writeFailures = 0;
  let closed = false;

  const stamp = (): string => new Date(now()).toISOString();

  const append = (line: string): void => {
    if (closed) return;
    try {
      const outcome = rollIfOversize(logPath, { maxBytes, keep });
      if (outcome.rolled) {
        appendFileSync(logPath, `${stamp()} log-rolled\n`);
      }
      appendFileSync(logPath, `${line}\n`);
    } catch {
      writeFailures += 1;
    }
  };

  const heartbeat = (): void => {
    const fields = [
      `window_ms=${now() - aggregate.windowStart}`,
      `drains=${aggregate.drains}`,
      `segments=${aggregate.segments_read}`,
      `lines=${aggregate.lines_read}`,
      `inserted=${aggregate.events_inserted}`,
      `already=${aggregate.events_already_present}`,
      `skipped=${aggregate.events_skipped}`,
      `quarantined=${aggregate.quarantined}`,
    ];
    if (writeFailures > 0) fields.push(`write_failures=${writeFailures}`);
    append(`${stamp()} heartbeat ${fields.join(" ")}`);
    aggregate = emptyAggregate(now());
  };

  const interval = setInterval(heartbeat, heartbeatMs);
  interval.unref();

  return {
    started(): void {
      append(`${stamp()} started pid=${process.pid}`);
    },
    ready(): void {
      append(`${stamp()} ready`);
    },
    shutdown(reason: string): void {
      append(`${stamp()} shutdown reason=${reason}`);
    },
    drain(result: DrainResult): void {
      if (closed) return;
      aggregate.drains += 1;
      aggregate.segments_read += result.segments_read;
      aggregate.lines_read += result.lines_read;
      aggregate.events_inserted += result.events_inserted;
      aggregate.events_already_present += result.events_already_present;
      aggregate.events_skipped += result.events_skipped;
      aggregate.quarantined += result.quarantined;
    },
    quarantined(count: number): void {
      append(`${stamp()} quarantine count=${count}`);
    },
    rotated(sealed: string): void {
      append(`${stamp()} rotated sealed=${basename(sealed)}`);
    },
    anomaly(context: string, err: unknown): void {
      append(
        `${stamp()} anomaly context="${context}" error=${describeError(err)}`,
      );
    },
    heartbeat,
    close(): void {
      if (closed) return;
      clearInterval(interval);
      if (aggregate.drains > 0) heartbeat();
      closed = true;
    },
  };
}
