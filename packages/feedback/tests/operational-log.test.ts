/**
 * The operational logger writes `<dataDir>/daemon.log` as a bounded, plain
 * operational record. These tests exercise the public interface against a
 * real temp directory with an injected clock, so timestamps and the
 * heartbeat window are deterministic. The heartbeat interval timer is just
 * `setInterval` over the public `heartbeat`, so it is exercised by calling
 * `heartbeat` directly rather than by waiting on wall-clock time.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DrainResult } from "../src/loader/drain.ts";
import { openOperationalLog } from "../src/loader/operational-log.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-oplog-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readLog(dir: string): string[] {
  const path = join(dir, "daemon.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

function drainResult(over: Partial<DrainResult> = {}): DrainResult {
  return {
    segments_read: 0,
    lines_read: 0,
    events_inserted: 0,
    events_already_present: 0,
    events_skipped: 0,
    quarantined: 0,
    drained_sealed: [],
    ...over,
  };
}

test("O1: lifecycle sinks each write one operational line", () => {
  withDir((dir) => {
    const log = openOperationalLog({
      dataDir: dir,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    try {
      log.started();
      log.ready();
      log.shutdown("SIGTERM");
    } finally {
      log.close();
    }
    const lines = readLog(dir);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain(" started ");
    expect(lines[1]).toContain(" ready");
    expect(lines[2]).toContain(" shutdown reason=SIGTERM");
  });
});

test("O2: drain folds silently and heartbeat emits the aggregate", () => {
  withDir((dir) => {
    let clock = 1000;
    const log = openOperationalLog({
      dataDir: dir,
      now: () => clock,
      heartbeatMs: 1_000_000,
    });
    try {
      log.drain(
        drainResult({ events_inserted: 5, lines_read: 7, segments_read: 1 }),
      );
      log.drain(
        drainResult({ events_inserted: 3, lines_read: 4, segments_read: 1 }),
      );
      expect(readLog(dir)).toEqual([]);
      clock = 601_000;
      log.heartbeat();
    } finally {
      log.close();
    }
    const lines = readLog(dir);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" heartbeat ");
    expect(lines[0]).toContain("window_ms=600000");
    expect(lines[0]).toContain("drains=2");
    expect(lines[0]).toContain("inserted=8");
    expect(lines[0]).toContain("lines=11");
  });
});

test("O3: close flushes a pending heartbeat and is idempotent", () => {
  withDir((dir) => {
    let clock = 1000;
    const log = openOperationalLog({
      dataDir: dir,
      now: () => clock,
      heartbeatMs: 1_000_000,
    });
    log.drain(drainResult({ events_inserted: 2 }));
    clock = 5000;
    log.close();
    log.close();
    const lines = readLog(dir);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" heartbeat ");
    expect(lines[0]).toContain("drains=1");
    expect(lines[0]).toContain("inserted=2");
  });
});

test("O4: daemon.log rolls past maxBytes and the fresh file notes it", () => {
  withDir((dir) => {
    let clock = 1000;
    const log = openOperationalLog({
      dataDir: dir,
      now: () => clock,
      heartbeatMs: 1_000_000,
      maxBytes: 256,
      keep: 2,
    });
    try {
      for (let i = 0; i < 20; i += 1) {
        clock += 1000;
        log.anomaly("loop", new Error(`boom ${i}`));
      }
    } finally {
      log.close();
    }
    expect(existsSync(join(dir, "daemon.log.1"))).toBe(true);
    expect(readLog(dir).some((line) => line.includes(" log-rolled"))).toBe(
      true,
    );
  });
});

test("O5: anomaly renders a multi-line error on a single line", () => {
  withDir((dir) => {
    const log = openOperationalLog({
      dataDir: dir,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    log.anomaly("driver shutdown", new Error("line one\nline two"));
    log.close();
    const lines = readLog(dir);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('context="driver shutdown"');
    expect(lines[0]).toContain("\\n");
  });
});
