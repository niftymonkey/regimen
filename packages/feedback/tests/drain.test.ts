/**
 * The loader's drainBuffer: reads every segment in the buffer, dispatches
 * each line through the translator registry, writes events into the store,
 * quarantines lines we cannot trust. These tests build a tmp buffer dir and
 * tmp store, exercise drainBuffer through its public contract, and verify
 * the events and quarantine tables via the store's SQL handle.
 */
import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceIdFor } from "@regimen/shared";
import type { RegimenEvent } from "../hooks/event-log.ts";
import { drainBuffer } from "../src/loader/drain.ts";
import { openStore, type Store } from "../src/store.ts";

interface Harness {
  bufferDir: string;
  store: Store;
}

function withHarness(fn: (h: Harness) => void): void {
  const root = mkdtempSync(join(tmpdir(), "regimen-drain-"));
  const bufferDir = join(root, "buffer");
  const store = openStore(join(root, "feedback.db"));
  try {
    fn({ bufferDir, store });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function writeCurrent(bufferDir: string, lines: string[]): void {
  mkdirSync(bufferDir, { recursive: true });
  writeFileSync(join(bufferDir, "current.jsonl"), lines.join("\n") + "\n");
}

function writeSealed(
  bufferDir: string,
  rfc3339: string,
  lines: string[],
): string {
  mkdirSync(bufferDir, { recursive: true });
  const path = join(bufferDir, `sealed-${rfc3339}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const SESSION_START_ENVELOPE = JSON.stringify({
  harness: "claude",
  captured_at: "2026-05-21T17:21:43.629Z",
  payload: {
    session_id: "drain-t1-session",
    hook_event_name: "SessionStart",
    source: "startup",
    model: "claude-opus-4-7",
  },
});

test("T1: one envelope drains to one events row with matching counts", () => {
  withHarness(({ bufferDir, store }) => {
    writeCurrent(bufferDir, [SESSION_START_ENVELOPE]);

    const result = drainBuffer(bufferDir, store);

    expect(result.segments_read).toBe(1);
    expect(result.lines_read).toBe(1);
    expect(result.events_inserted).toBe(1);
    expect(result.events_already_present).toBe(0);
    expect(result.events_skipped).toBe(0);
    expect(result.quarantined).toBe(0);

    const rowCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(rowCount).toBe(1);

    const row = store.db
      .prepare(
        "SELECT session_id, event_type, harness, span_phase, span_name FROM events",
      )
      .get() as {
      session_id: string;
      event_type: string;
      harness: string;
      span_phase: string;
      span_name: string;
    };
    expect(row.session_id).toBe("drain-t1-session");
    expect(row.event_type).toBe("session.start");
    expect(row.harness).toBe("claude");
    expect(row.span_phase).toBe("start");
    expect(row.span_name).toBe("session");
  });
});

test("T2: draining the same buffer twice still yields one events row", () => {
  withHarness(({ bufferDir, store }) => {
    writeCurrent(bufferDir, [SESSION_START_ENVELOPE]);

    const first = drainBuffer(bufferDir, store);
    expect(first.events_inserted).toBe(1);
    expect(first.events_already_present).toBe(0);

    const second = drainBuffer(bufferDir, store);
    expect(second.events_inserted).toBe(0);
    expect(second.events_already_present).toBe(1);
    expect(second.lines_read).toBe(1);
    expect(second.quarantined).toBe(0);

    const rowCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(rowCount).toBe(1);
  });
});

test("T3: mixed envelope and v1-direct lines both land in events", () => {
  withHarness(({ bufferDir, store }) => {
    const sessionId = "drain-t3-session";
    const directV1: RegimenEvent = {
      schema_version: 1,
      timestamp: "2026-05-21T17:22:01.000Z",
      session_id: sessionId,
      harness: "claude",
      event_type: "user_prompt",
      trace_id: traceIdFor(sessionId),
      span_phase: "point",
      span_name: "user_prompt",
      attributes: {},
    };
    writeCurrent(bufferDir, [SESSION_START_ENVELOPE, JSON.stringify(directV1)]);

    const result = drainBuffer(bufferDir, store);

    expect(result.lines_read).toBe(2);
    expect(result.events_inserted).toBe(2);
    expect(result.events_skipped).toBe(0);
    expect(result.quarantined).toBe(0);

    const types = (
      store.db
        .prepare("SELECT event_type FROM events ORDER BY event_type")
        .all() as ReadonlyArray<{ event_type: string }>
    ).map((row) => row.event_type);
    expect(types).toEqual(["session.start", "user_prompt"]);
  });
});

test("T4: a malformed line goes to quarantine and events stays untouched", () => {
  withHarness(({ bufferDir, store }) => {
    const badLine = "{not-json";
    writeCurrent(bufferDir, [SESSION_START_ENVELOPE, badLine]);

    const result = drainBuffer(bufferDir, store);

    expect(result.lines_read).toBe(2);
    expect(result.events_inserted).toBe(1);
    expect(result.quarantined).toBe(1);

    const eventCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(eventCount).toBe(1);

    const quarantineRow = store.db
      .prepare("SELECT raw_line, reason FROM quarantine")
      .get() as { raw_line: string; reason: string };
    expect(quarantineRow.raw_line).toBe(badLine);
    expect(quarantineRow.reason).toMatch(/JSON parse failure/);
  });
});

test("T6: a sealed segment read to EOF is reported in drained_sealed", () => {
  withHarness(({ bufferDir, store }) => {
    const sealedPath = writeSealed(bufferDir, "2026-05-21T17-00-00Z", [
      SESSION_START_ENVELOPE,
    ]);

    const result = drainBuffer(bufferDir, store);

    expect(result.drained_sealed).toEqual([sealedPath]);
  });
});

test("T7: current.jsonl is never reported in drained_sealed", () => {
  withHarness(({ bufferDir, store }) => {
    const sealedPath = writeSealed(bufferDir, "2026-05-21T17-00-00Z", [
      SESSION_START_ENVELOPE,
    ]);
    writeCurrent(bufferDir, [SESSION_START_ENVELOPE]);

    const result = drainBuffer(bufferDir, store);

    expect(result.drained_sealed).toEqual([sealedPath]);
  });
});

test("T5: draining the real Claude samples fixture matches dispatch counts", () => {
  withHarness(({ bufferDir, store }) => {
    mkdirSync(bufferDir, { recursive: true });
    copyFileSync(
      join(import.meta.dir, "..", "samples", "claude-envelopes.jsonl"),
      join(bufferDir, "current.jsonl"),
    );

    const result = drainBuffer(bufferDir, store);

    expect(result.segments_read).toBe(1);
    expect(result.lines_read).toBe(39);
    expect(result.events_inserted).toBe(35);
    expect(result.events_skipped).toBe(4);
    expect(result.quarantined).toBe(0);

    const eventCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(eventCount).toBe(35);
  });
});
