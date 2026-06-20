/**
 * The daemon: the composition root that wires Source, Projection, State, and
 * Exporter into a poll loop. It holds no domain logic of its own.
 *
 * One `tick` does, per signal stream: read the stream's watermark, pull the
 * batch since it, and if the batch is non-empty, project it and send it. A
 * stream's watermark advances only after its send reports `ok`, so a failed
 * delivery is retried on the next tick rather than lost, and the three streams
 * advance independently.
 */
import { eventsToLogs } from "./projection/logs.ts";
import { projectMetrics } from "./projection/metrics.ts";
import { projectTraces } from "./projection/traces.ts";
import type { ProjectionOptions } from "./projection/resource.ts";
import type { Source } from "./source/source.ts";
import type { WatermarkStore } from "./state/watermarks.ts";
import {
  payloadSize,
  type Exporter,
  type OtlpPayload,
} from "./exporter/port.ts";
import type { DaemonLog } from "./operational-log.ts";

export interface DaemonDeps {
  source: Source;
  state: WatermarkStore;
  exporter: Exporter;
  options: ProjectionOptions;
  /** Poll interval for `start`; the test path calls `tick` directly. */
  cadenceMs?: number;
  /** Where the poll loop reports its activity; defaults to a no-op log. */
  log?: DaemonLog;
}

export interface Daemon {
  /** Run one poll cycle across all three streams. */
  tick(): Promise<void>;
  /** Begin polling on the cadence. */
  start(): void;
  /** Stop polling and release the database handle. */
  stop(): void;
}

/** One stream's work for a tick: what to send and the watermark it earns. */
interface StreamStep {
  payload: OtlpPayload;
  nextWatermark: string | null;
}

const DEFAULT_CADENCE_MS = 2000;

/** A DaemonLog that records nothing; the default when no log is wired in. */
const noopLog: DaemonLog = {
  tick() {},
  delivered() {},
  sendFailed() {},
  anomaly() {},
};

/** Wire the dependencies into a daemon. */
export function createDaemon(deps: DaemonDeps): Daemon {
  const { source, state, exporter, options } = deps;
  const cadenceMs = deps.cadenceMs ?? DEFAULT_CADENCE_MS;
  const log = deps.log ?? noopLog;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function logsStep(): StreamStep | null {
    const batch = source.pullLogs(state.read("logs"));
    if (batch.rows.length === 0) return null;
    return {
      payload: { stream: "logs", data: eventsToLogs(batch.rows, options) },
      nextWatermark: batch.nextWatermark,
    };
  }

  function metricsStep(observedAt: string): StreamStep | null {
    const batch = source.pullMetrics(state.read("metrics"));
    // counts cover every active conversation, so empty counts means nothing
    // is active and the file-edit and gate-denial sub-signals are empty too.
    if (batch.counts.length === 0) return null;
    return {
      payload: {
        stream: "metrics",
        data: projectMetrics(batch, options, observedAt),
      },
      nextWatermark: batch.nextWatermark,
    };
  }

  function tracesStep(): StreamStep | null {
    const batch = source.pullTraces(state.read("traces"));
    const empty =
      batch.sessionSpans.length === 0 &&
      batch.toolSpans.length === 0 &&
      batch.pointEvents.length === 0;
    if (empty) return null;
    return {
      payload: { stream: "traces", data: projectTraces(batch, options) },
      nextWatermark: batch.nextWatermark,
    };
  }

  async function tick(): Promise<void> {
    log.tick();
    const observedAt = new Date().toISOString();
    for (const step of [logsStep(), metricsStep(observedAt), tracesStep()]) {
      if (step === null) continue;
      const stream = step.payload.stream;
      const result = await exporter.send(step.payload);
      if (!result.ok) {
        // A failed send leaves the watermark unadvanced, so the next tick
        // retries the same batch; the log records the failure to act on.
        log.sendFailed(stream, result.error);
        continue;
      }
      log.delivered(stream, payloadSize(step.payload));
      if (step.nextWatermark !== null) {
        state.commit(stream, step.nextWatermark);
      }
    }
  }

  // Schedule each tick only once the previous one has settled. setInterval
  // would fire on a fixed cadence regardless, so a tick slower than the
  // cadence (a slow send, or the first backlog flush) would overlap a second
  // tick that re-reads the same watermark and double-sends the same batch.
  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(() => {
      tick()
        .catch((cause: unknown) => {
          log.anomaly("tick", cause);
        })
        .finally(scheduleNext);
    }, cadenceMs);
  }

  return {
    tick,
    start(): void {
      if (running) return;
      running = true;
      scheduleNext();
    },
    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      source.close();
    },
  };
}
