/**
 * The bridge's operational logger writes `bridge.log` as a bounded, plain
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
import { consoleLog, openOperationalLog } from "../src/operational-log.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-bridge-oplog-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readLog(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

test("O1: started writes one operational line", () => {
  withDir((dir) => {
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    try {
      log.started("/data/feedback.db");
    } finally {
      log.close();
    }
    const lines = readLog(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" started ");
    expect(lines[0]).toContain('db="/data/feedback.db"');
    expect(lines[0]).toContain("1970-01-01T00:00:01.000Z");
  });
});

test("O2: delivered folds silently and the heartbeat emits the aggregate", () => {
  withDir((dir) => {
    let clock = 1000;
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => clock,
      heartbeatMs: 1_000_000,
    });
    try {
      log.delivered("logs", 5);
      log.delivered("traces", 3);
      log.delivered("logs", 2);
      expect(readLog(logPath)).toEqual([]);
      clock = 601_000;
      log.heartbeat();
    } finally {
      log.close();
    }
    const lines = readLog(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" heartbeat ");
    expect(lines[0]).toContain("window_ms=600000");
    expect(lines[0]).toContain("logs=7");
    expect(lines[0]).toContain("traces=3");
    expect(lines[0]).toContain("metrics=0");
  });
});

test("O3: tick count rides along on the heartbeat line", () => {
  withDir((dir) => {
    let clock = 1000;
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => clock,
      heartbeatMs: 1_000_000,
    });
    try {
      log.tick();
      log.tick();
      log.tick();
      clock = 601_000;
      log.heartbeat();
    } finally {
      log.close();
    }
    const lines = readLog(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" heartbeat ");
    expect(lines[0]).toContain("ticks=3");
  });
});

test("O4: shutdown writes one line immediately", () => {
  withDir((dir) => {
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    log.shutdown("SIGTERM");
    log.close();
    const lines = readLog(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" shutdown reason=SIGTERM");
  });
});

test("O5: close flushes a pending heartbeat and is idempotent", () => {
  withDir((dir) => {
    let clock = 1000;
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => clock,
      heartbeatMs: 1_000_000,
    });
    log.tick();
    log.delivered("metrics", 4);
    clock = 5000;
    log.close();
    log.close();
    const lines = readLog(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" heartbeat ");
    expect(lines[0]).toContain("ticks=1");
    expect(lines[0]).toContain("metrics=4");
  });
});

test("O6: a send failure logs once on the transition; the heartbeat counts repeats", () => {
  withDir((dir) => {
    let clock = 1000;
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => clock,
      heartbeatMs: 1_000_000,
    });
    try {
      log.sendFailed("traces", "HTTP 422\nTRACE_TOO_LARGE");
      log.sendFailed("traces", "HTTP 422\nTRACE_TOO_LARGE");
      // One line for the transition into failing; the repeat adds none, and
      // the embedded newline did not split the entry across two lines.
      let lines = readLog(logPath);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("send-failed stream=traces");
      expect(lines[0]).toContain("HTTP 422");
      clock = 601_000;
      log.heartbeat();
      lines = readLog(logPath);
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain("traces_failed=2");
    } finally {
      log.close();
    }
  });
});

test("O7: a delivery after a failure logs the stream's recovery once", () => {
  withDir((dir) => {
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    try {
      log.sendFailed("logs", "network error");
      log.delivered("logs", 10);
      log.delivered("logs", 5);
      const lines = readLog(logPath);
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("send-failed stream=logs");
      expect(lines[1]).toContain("recovered stream=logs");
    } finally {
      log.close();
    }
  });
});

test("O8: anomaly renders a multi-line error on a single line", () => {
  withDir((dir) => {
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    log.anomaly("tick", new Error("line one\nline two"));
    log.close();
    const lines = readLog(logPath);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(" anomaly ");
    expect(lines[0]).toContain('context="tick"');
    expect(lines[0]).toContain("\\n");
  });
});

test("O9: bridge.log rolls past maxBytes and the fresh file notes it", () => {
  withDir((dir) => {
    let clock = 1000;
    const logPath = join(dir, "bridge.log");
    const log = openOperationalLog({
      logPath,
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
    expect(existsSync(join(dir, "bridge.log.1"))).toBe(true);
    expect(readLog(logPath).some((line) => line.includes(" log-rolled"))).toBe(
      true,
    );
  });
});

test("O10: a write failure is swallowed rather than thrown", () => {
  withDir((dir) => {
    // The data directory itself as the log path: every append hits EISDIR,
    // so a logging failure cannot crash the bridge it observes.
    const log = openOperationalLog({
      logPath: dir,
      now: () => 1000,
      heartbeatMs: 1_000_000,
    });
    expect(() => {
      log.started("/data/feedback.db");
      log.sendFailed("logs", "boom");
      log.anomaly("tick", new Error("boom"));
      log.heartbeat();
      log.close();
    }).not.toThrow();
  });
});

test("C1: consoleLog writes lifecycle and failure events, not routine ones", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg?: unknown): void => {
    lines.push(String(msg));
  };
  try {
    const log = consoleLog();
    log.started("/data/feedback.db");
    log.delivered("logs", 5); // routine: folded away, no line
    log.tick(); // routine: no line
    log.sendFailed("traces", "HTTP 422");
    log.shutdown("SIGINT");
    log.close();
  } finally {
    console.error = original;
  }
  expect(lines.length).toBe(3);
  expect(lines[0]).toContain(" started ");
  expect(lines[1]).toContain("send-failed stream=traces");
  expect(lines[2]).toContain("shutdown reason=SIGINT");
});
