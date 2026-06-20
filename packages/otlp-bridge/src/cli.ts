#!/usr/bin/env bun
/**
 * CLI entry: run the bridge as a foreground daemon.
 *
 *   bun run src/cli.ts            stream to Grafana Cloud
 *   bun run src/cli.ts --dry-run  log what would be sent, send nothing
 *
 * The daemon reads the Feedback store at `<dataDir>/feedback.db` and streams
 * its evidence-layer signals as OTLP logs, metrics, and traces. Grafana Cloud
 * credentials come from `GRAFANA_CLOUD_OTLP_ENDPOINT` and
 * `GRAFANA_CLOUD_BASIC_AUTH_HEADER`; resource attributes from
 * `REGIMEN_SERVICE_NAME`, `REGIMEN_SERVICE_VERSION`, `REGIMEN_ENVIRONMENT`.
 */
import { existsSync } from "node:fs";
import { createDaemon } from "./daemon.ts";
import { openSource } from "./source/source.ts";
import {
  memoryWatermarkStore,
  openWatermarkStore,
  type WatermarkStore,
} from "./state/watermarks.ts";
import { httpExporter } from "./exporter/http.ts";
import {
  payloadSize,
  type Exporter,
  type OtlpPayload,
  type SendResult,
} from "./exporter/port.ts";
import type { ProjectionOptions } from "./projection/resource.ts";
import {
  bridgeLogPath,
  dataDir,
  feedbackDbPath,
  watermarkPath,
} from "./data-dir.ts";
import {
  consoleLog,
  openOperationalLog,
  type OperationalLog,
} from "./operational-log.ts";

const SCOPE_NAME = "regimen-otlp-bridge";
const SCOPE_VERSION = "0.1.0";

function projectionOptions(): ProjectionOptions {
  return {
    serviceName: process.env.REGIMEN_SERVICE_NAME ?? "regimen",
    serviceVersion: process.env.REGIMEN_SERVICE_VERSION ?? "0.0.0",
    environment: process.env.REGIMEN_ENVIRONMENT ?? "dev",
    scopeName: SCOPE_NAME,
    scopeVersion: SCOPE_VERSION,
  };
}

/** A one-line count of what a payload would deliver, for the dry-run log. */
function summarize(payload: OtlpPayload): string {
  const unit =
    payload.stream === "logs"
      ? "log record"
      : payload.stream === "traces"
        ? "span"
        : "metric";
  return `${payloadSize(payload)} ${unit}(s)`;
}

/** A dry-run exporter: logs a summary of each payload and delivers nothing. */
function dryRunExporter(): Exporter {
  return {
    send(payload: OtlpPayload): Promise<SendResult> {
      console.error(
        `bridge: dry-run ${payload.stream} (${summarize(payload)})`,
      );
      return Promise.resolve({ ok: true });
    },
  };
}

/** The live exporter, or exit with a clear message when credentials are absent. */
function liveExporter(): Exporter {
  const endpoint = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT;
  const authHeader = process.env.GRAFANA_CLOUD_BASIC_AUTH_HEADER;
  if (
    endpoint === undefined ||
    endpoint.length === 0 ||
    authHeader === undefined ||
    authHeader.length === 0
  ) {
    console.error(
      "bridge: set GRAFANA_CLOUD_OTLP_ENDPOINT and GRAFANA_CLOUD_BASIC_AUTH_HEADER, or pass --dry-run",
    );
    process.exit(1);
  }
  return httpExporter({ endpoint, authHeader });
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const dir = dataDir();
  const dbPath = feedbackDbPath(dir);
  if (!existsSync(dbPath)) {
    console.error(
      `bridge: no Feedback store at ${dbPath}. Is 'feedback start' running?`,
    );
    process.exit(1);
  }
  // A dry run delivers nothing, keeps its watermarks in memory so it never
  // advances the state a real run resumes from, and logs to the console
  // rather than owning a `bridge.log`. A live run does all three for real.
  const exporter = dryRun ? dryRunExporter() : liveExporter();
  const state: WatermarkStore = dryRun
    ? memoryWatermarkStore()
    : openWatermarkStore(watermarkPath(dir));
  const log: OperationalLog = dryRun
    ? consoleLog()
    : openOperationalLog({ logPath: bridgeLogPath(dir) });

  const daemon = createDaemon({
    source: openSource(dbPath),
    state,
    exporter,
    options: projectionOptions(),
    log,
  });

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log.shutdown(signal);
      daemon.stop();
      log.close();
      process.exit(0);
    });
  }

  log.started(dbPath);
  daemon.start();
}

main();
