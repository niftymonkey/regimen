import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memoryWatermarkStore,
  openWatermarkStore,
} from "../../src/state/watermarks.ts";

/** A fresh temp path for a watermark file that does not yet exist. */
function tempWatermarkFile(): string {
  return join(
    mkdtempSync(join(tmpdir(), "regimen-bridge-wm-")),
    "watermarks.json",
  );
}

test("a committed watermark is read back for the same stream", () => {
  const store = openWatermarkStore(tempWatermarkFile());

  store.commit("logs", "2026-05-21T12:00:00.000Z");

  expect(store.read("logs")).toBe("2026-05-21T12:00:00.000Z");
});

test("a stream with no committed watermark reads as null", () => {
  const store = openWatermarkStore(tempWatermarkFile());

  expect(store.read("traces")).toBeNull();
});

test("each stream advances its watermark independently", () => {
  const store = openWatermarkStore(tempWatermarkFile());

  store.commit("logs", "2026-05-21T12:00:00.000Z");
  store.commit("metrics", "2026-05-21T09:30:00.000Z");

  expect(store.read("logs")).toBe("2026-05-21T12:00:00.000Z");
  expect(store.read("metrics")).toBe("2026-05-21T09:30:00.000Z");
  expect(store.read("traces")).toBeNull();
});

test("a corrupt watermark file reads as null rather than throwing", () => {
  const path = tempWatermarkFile();
  writeFileSync(path, "{ this is not valid json");
  const store = openWatermarkStore(path);

  expect(store.read("logs")).toBeNull();
});

test("a commit after a corrupt file recovers the file", () => {
  const path = tempWatermarkFile();
  writeFileSync(path, "}{ torn write");
  const store = openWatermarkStore(path);

  store.commit("traces", "2026-05-21T15:00:00.000Z");

  expect(store.read("traces")).toBe("2026-05-21T15:00:00.000Z");
});

test("a watermark persists to disk and is read by a fresh store instance", () => {
  const path = tempWatermarkFile();
  openWatermarkStore(path).commit("logs", "2026-05-21T12:00:00.000Z");

  // A new store instance, as a restarted daemon opens.
  expect(openWatermarkStore(path).read("logs")).toBe(
    "2026-05-21T12:00:00.000Z",
  );
});

test("an in-memory store round-trips a watermark without touching disk", () => {
  const store = memoryWatermarkStore();

  expect(store.read("logs")).toBeNull();
  store.commit("logs", "2026-05-21T12:00:00.000Z");

  expect(store.read("logs")).toBe("2026-05-21T12:00:00.000Z");
});
