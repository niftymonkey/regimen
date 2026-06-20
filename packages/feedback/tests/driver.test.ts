/**
 * The loader driver's behavior: initial drain on start, debounced re-drains
 * on watcher change signals, clean shutdown. The driver takes a watcher
 * abstraction so these tests drive it with a synthetic watcher and never
 * touch chokidar or real filesystem watching.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSealedSegment } from "../hooks/event-log.ts";
import {
  startDriver,
  type BufferWatcher,
  type DriverHandle,
} from "../src/loader/driver.ts";
import type { DrainResult } from "../src/loader/drain.ts";
import { openStore, type Store } from "../src/store.ts";

interface Harness {
  bufferDir: string;
  store: Store;
  watcher: FakeWatcher;
  drains: DrainResult[];
}

interface FakeWatcher extends BufferWatcher {
  fire(): void;
  closed: boolean;
}

function makeWatcher(): FakeWatcher {
  let listener: (() => void) | null = null;
  const watcher: FakeWatcher = {
    closed: false,
    onChange(cb) {
      listener = cb;
    },
    close() {
      watcher.closed = true;
    },
    fire() {
      listener?.();
    },
  };
  return watcher;
}

function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "regimen-driver-"));
  const bufferDir = join(root, "buffer");
  mkdirSync(bufferDir, { recursive: true });
  const store = openStore(join(root, "feedback.db"));
  const watcher = makeWatcher();
  const drains: DrainResult[] = [];
  return fn({ bufferDir, store, watcher, drains }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

const ENVELOPE = (sessionId: string): string =>
  JSON.stringify({
    harness: "claude",
    captured_at: "2026-05-21T17:21:43.629Z",
    payload: {
      session_id: sessionId,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-opus-4-7",
    },
  });

function writeCurrent(bufferDir: string, lines: string[]): void {
  writeFileSync(join(bufferDir, "current.jsonl"), lines.join("\n") + "\n");
}

function writeSealed(
  bufferDir: string,
  rfc3339: string,
  lines: string[],
): string {
  const path = join(bufferDir, `sealed-${rfc3339}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function sealedSegments(bufferDir: string): string[] {
  return readdirSync(bufferDir).filter(isSealedSegment);
}

/** Resolve once the driver reports any drain via onDrain. */
function nextDrain(handle: { drains: DrainResult[] }): Promise<DrainResult> {
  return new Promise((resolve) => {
    const start = handle.drains.length;
    const tick = (): void => {
      if (handle.drains.length > start) {
        resolve(handle.drains[handle.drains.length - 1]!);
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function shutdownAndWait(driver: DriverHandle): Promise<void> {
  await driver.shutdown();
}

test("T6.1: startDriver runs an initial drain immediately", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(bufferDir, [ENVELOPE("driver-t6-1")]);

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      onDrain: (r) => drains.push(r),
    });

    expect(drains.length).toBe(1);
    expect(drains[0]!.events_inserted).toBe(1);

    const rowCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(rowCount).toBe(1);

    await shutdownAndWait(driver);
  });
});

test("T6.2: watcher.onChange triggers a re-drain that picks up new envelopes", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(bufferDir, [ENVELOPE("driver-t6-2-a")]);

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      onDrain: (r) => drains.push(r),
    });
    expect(drains.length).toBe(1);

    writeCurrent(bufferDir, [
      ENVELOPE("driver-t6-2-a"),
      ENVELOPE("driver-t6-2-b"),
    ]);
    watcher.fire();

    const second = await nextDrain({ drains });
    expect(second.lines_read).toBe(2);
    expect(second.events_inserted).toBe(1);
    expect(second.events_already_present).toBe(1);

    const sessionIds = (
      store.db
        .prepare("SELECT DISTINCT session_id FROM events ORDER BY session_id")
        .all() as ReadonlyArray<{ session_id: string }>
    ).map((row) => row.session_id);
    expect(sessionIds).toEqual(["driver-t6-2-a", "driver-t6-2-b"]);

    await shutdownAndWait(driver);
  });
});

test("T6.3: a burst of change signals coalesces into one re-drain", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(bufferDir, [ENVELOPE("driver-t6-3")]);

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 30,
      onDrain: (r) => drains.push(r),
    });
    expect(drains.length).toBe(1);

    watcher.fire();
    watcher.fire();
    watcher.fire();
    watcher.fire();

    await nextDrain({ drains });
    await new Promise((r) => setTimeout(r, 80));

    expect(drains.length).toBe(2);

    await shutdownAndWait(driver);
  });
});

test("T6.5: driver fires onDisabled exactly once when the enabled flag goes away", async () => {
  await withHarness(async ({ bufferDir, store, watcher }) => {
    let enabled = true;
    const fired: number[] = [];

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      flagPoll: {
        isEnabled: () => enabled,
        intervalMs: 20,
        onDisabled: () => fired.push(Date.now()),
      },
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(fired.length).toBe(0);

    enabled = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(fired.length).toBe(1);

    await new Promise((r) => setTimeout(r, 80));
    expect(fired.length).toBe(1);

    await shutdownAndWait(driver);
  });
});

test("T6.6: a sealed segment is unlinked once the driver has drained it", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    const sealedPath = writeSealed(bufferDir, "2026-05-21T17-00-00-000Z", [
      ENVELOPE("driver-t6-6-sealed"),
    ]);
    writeCurrent(bufferDir, [ENVELOPE("driver-t6-6-current")]);

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      onDrain: (r) => drains.push(r),
    });

    expect(existsSync(sealedPath)).toBe(false);
    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(true);

    const rowCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(rowCount).toBe(2);

    await shutdownAndWait(driver);
  });
});

test("T6.7: the driver seals current.jsonl once it crosses the size threshold", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(
      bufferDir,
      Array.from({ length: 40 }, (_, i) => ENVELOPE(`driver-t6-7-${i}`)),
    );

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      onDrain: (r) => drains.push(r),
      rotation: { maxBytes: 512 },
    });

    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(false);
    expect(sealedSegments(bufferDir).length).toBe(1);

    await shutdownAndWait(driver);
  });
});

test("T6.8: a rotation triggers a re-drain that consumes the new sealed segment", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(
      bufferDir,
      Array.from({ length: 40 }, (_, i) => ENVELOPE(`driver-t6-8-${i}`)),
    );

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      onDrain: (r) => drains.push(r),
      rotation: { maxBytes: 512 },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(drains.length).toBe(2);
    expect(sealedSegments(bufferDir).length).toBe(0);
    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(false);

    const rowCount = (
      store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      }
    ).n;
    expect(rowCount).toBe(40);

    await shutdownAndWait(driver);
  });
});

test("T6.9: onRotate fires with the sealed segment path when the driver rotates", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(
      bufferDir,
      Array.from({ length: 40 }, (_, i) => ENVELOPE(`driver-t6-9-${i}`)),
    );
    const rotated: string[] = [];

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 0,
      onDrain: (r) => drains.push(r),
      onRotate: (sealed) => rotated.push(sealed),
      rotation: { maxBytes: 512 },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(rotated.length).toBe(1);
    expect(isSealedSegment(rotated[0]!)).toBe(true);

    await shutdownAndWait(driver);
  });
});

test("T6.4: shutdown closes the watcher and cancels any pending drain", async () => {
  await withHarness(async ({ bufferDir, store, watcher, drains }) => {
    writeCurrent(bufferDir, [ENVELOPE("driver-t6-4")]);

    const driver = startDriver({
      bufferDir,
      store,
      watcher,
      debounceMs: 200,
      onDrain: (r) => drains.push(r),
    });
    expect(drains.length).toBe(1);

    watcher.fire();
    await driver.shutdown();

    expect(watcher.closed).toBe(true);
    expect(drains.length).toBe(1);

    await new Promise((r) => setTimeout(r, 300));
    expect(drains.length).toBe(1);
  });
});
