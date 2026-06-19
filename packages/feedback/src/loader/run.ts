#!/usr/bin/env bun
/**
 * Foreground entrypoint for the Feedback loader.
 *
 * Resolves the data dir per OS (or honours `REGIMEN_DATA_DIR`), opens the
 * SQLite store, wraps chokidar in a `BufferWatcher`, and hands both to
 * `startDriver`. Per ADR-0006 this is the "opt-in always-on daemon" in
 * foreground form; the install/lifecycle wrapper that backgrounds this
 * entrypoint lands later under #19.
 */
import chokidar from "chokidar";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bufferDir as bufferDirFor, dataDir } from "@regimen/shared";
import { isEnabled } from "../enabled-flag.ts";
import { recordError } from "../../hooks/event-log.ts";
import { openStore } from "../store.ts";
import {
  startDriver,
  type BufferWatcher,
  type DriverHandle,
} from "./driver.ts";
import { openOperationalLog } from "./operational-log.ts";
import {
  startRolloutTailer,
  type RolloutTailerHandle,
} from "./rollout/tailer.ts";

function chokidarBufferWatcher(
  bufferDir: string,
  onReady: () => void,
): BufferWatcher {
  const watcher = chokidar.watch(bufferDir, {
    ignoreInitial: true,
    awaitWriteFinish: false,
    persistent: true,
  });
  watcher.on("ready", onReady);
  return {
    onChange(listener) {
      watcher.on("add", listener);
      watcher.on("change", listener);
    },
    async close() {
      await watcher.close();
    },
  };
}

async function main(): Promise<void> {
  const dir = dataDir();
  if (!isEnabled(dir)) {
    process.stderr.write(
      "feedback is not enabled; run `feedback start` first\n",
    );
    process.exit(1);
  }
  const buffer = bufferDirFor(dir);
  mkdirSync(buffer, { recursive: true });
  const storePath = join(dir, "feedback.db");
  const pidPath = join(dir, "daemon.pid");

  const store = openStore(storePath);
  writeFileSync(pidPath, `${process.pid}\n`);
  const log = openOperationalLog({ dataDir: dir });
  log.started();
  const watcher = chokidarBufferWatcher(buffer, () => {
    process.stdout.write("ready\n");
    log.ready();
  });

  let shuttingDown = false;
  let tailer: RolloutTailerHandle | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.shutdown(reason);
    tailer?.stop();
    try {
      await driver.shutdown();
    } catch (err) {
      log.anomaly("driver shutdown", err);
    }
    log.close();
    store.close();
    rmSync(pidPath, { force: true });
    process.exit(0);
  };

  const flagPollMs = Number(process.env.REGIMEN_FLAG_POLL_MS) || 2000;
  const rotation: { maxBytes?: number; maxAgeMs?: number } = {};
  const envMaxBytes = Number(process.env.REGIMEN_ROTATE_MAX_BYTES);
  if (Number.isFinite(envMaxBytes) && envMaxBytes > 0) {
    rotation.maxBytes = envMaxBytes;
  }
  const envMaxAgeMs = Number(process.env.REGIMEN_ROTATE_MAX_AGE_MS);
  if (Number.isFinite(envMaxAgeMs) && envMaxAgeMs > 0) {
    rotation.maxAgeMs = envMaxAgeMs;
  }
  const driver: DriverHandle = startDriver({
    bufferDir: buffer,
    store,
    watcher,
    rotation,
    onDrain: (r) => {
      log.drain(r);
      if (r.quarantined > 0) log.quarantined(r.quarantined);
    },
    onRotate: (sealed) => log.rotated(sealed),
    flagPoll: {
      isEnabled: () => isEnabled(dir),
      intervalMs: flagPollMs,
      onDisabled: () => void shutdown("feedback disabled"),
    },
  });

  // Opt-in rollout tailer: the version-proof fallback capture (Phase 1.4). Off
  // unless REGIMEN_CODEX_SESSIONS_DIR names a Codex sessions root, so it never
  // double-captures alongside live hooks by default; the trial enables it if
  // app hooks regress. It polls that tree and feeds the same store as the
  // buffer drain, leaning on event-hash idempotency so re-reads are no-ops.
  const codexSessionsDir = process.env.REGIMEN_CODEX_SESSIONS_DIR;
  if (codexSessionsDir !== undefined && codexSessionsDir.length > 0) {
    const rolloutPollMs = Number(process.env.REGIMEN_ROLLOUT_POLL_MS) || 5000;
    tailer = startRolloutTailer({
      sessionsDir: codexSessionsDir,
      sink: (event) => {
        store.insertEvent(event);
      },
      onQuarantine: (record) => {
        store.quarantine(record.rawLine, `${record.file}: ${record.reason}`);
        log.quarantined(1);
      },
      onUnknownTypes: (unknownRecordTypes) => {
        log.anomaly(
          "rollout unknown record types",
          new Error(JSON.stringify(unknownRecordTypes)),
        );
      },
      intervalMs: rolloutPollMs,
    });
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((err) => {
    recordError(err);
    process.exit(1);
  });
}
