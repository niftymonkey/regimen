import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  appendEvent,
  listSegments,
  recordError,
  type RegimenEvent,
} from "../hooks/event-log.ts";

function withSeededDir(
  files: Record<string, string>,
  fn: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-segments-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("listSegments is empty when the buffer directory does not exist", () => {
  expect(listSegments(join(tmpdir(), "regimen-absent-9z8y7x"))).toEqual([]);
});

test("listSegments returns current.jsonl when only it exists", () => {
  withSeededDir({ "current.jsonl": "" }, (dir) => {
    const segments = listSegments(dir);
    expect(segments.map((path) => basename(path))).toEqual(["current.jsonl"]);
  });
});

test("listSegments returns sealed segments in chronological order", () => {
  withSeededDir(
    {
      "sealed-2026-05-21T12:00:00Z.jsonl": "",
      "sealed-2026-05-21T08:00:00Z.jsonl": "",
      "sealed-2026-05-21T10:00:00Z.jsonl": "",
    },
    (dir) => {
      const segments = listSegments(dir).map((path) => basename(path));
      expect(segments).toEqual([
        "sealed-2026-05-21T08:00:00Z.jsonl",
        "sealed-2026-05-21T10:00:00Z.jsonl",
        "sealed-2026-05-21T12:00:00Z.jsonl",
      ]);
    },
  );
});

test("listSegments returns sealed segments first, then current.jsonl last", () => {
  withSeededDir(
    {
      "current.jsonl": "",
      "sealed-2026-05-21T08:00:00Z.jsonl": "",
      "sealed-2026-05-21T10:00:00Z.jsonl": "",
    },
    (dir) => {
      const segments = listSegments(dir).map((path) => basename(path));
      expect(segments).toEqual([
        "sealed-2026-05-21T08:00:00Z.jsonl",
        "sealed-2026-05-21T10:00:00Z.jsonl",
        "current.jsonl",
      ]);
    },
  );
});

test("listSegments ignores non-segment files in the buffer directory", () => {
  withSeededDir(
    {
      "current.jsonl": "",
      "sealed-2026-05-21T08:00:00Z.jsonl": "",
      "feedback.db": "",
      "feedback.db-wal": "",
      "capture-errors.log": "",
      "notes.txt": "",
    },
    (dir) => {
      const segments = listSegments(dir).map((path) => basename(path));
      expect(segments).toEqual([
        "sealed-2026-05-21T08:00:00Z.jsonl",
        "current.jsonl",
      ]);
    },
  );
});

test("appendEvent writes a v1 event JSON line to <dir>/current.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-append-event-"));
  try {
    const event: RegimenEvent = {
      schema_version: 1,
      timestamp: "2026-05-21T12:00:00.000Z",
      session_id: "session-x",
      harness: "claude",
      event_type: "compaction",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_phase: "point",
      span_name: "compaction",
      attributes: { trigger: "manual" },
    };
    appendEvent(event, dir);
    const lines = readFileSync(join(dir, "current.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(event);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordError keeps capture-errors.log bounded by rolling it", () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-capture-errors-"));
  const prevDataDir = process.env.REGIMEN_DATA_DIR;
  const prevMax = process.env.REGIMEN_CAPTURE_LOG_MAX_BYTES;
  process.env.REGIMEN_DATA_DIR = dir;
  process.env.REGIMEN_CAPTURE_LOG_MAX_BYTES = "512";
  try {
    for (let i = 0; i < 50; i += 1) {
      recordError(new Error(`failure ${i} ${"detail".repeat(20)}`));
    }
    const path = join(dir, "capture-errors.log");
    expect(existsSync(path)).toBe(true);
    // The active file is bounded to roughly the cap plus one trailing line,
    // far below the unbounded total of fifty appends.
    expect(statSync(path).size).toBeLessThan(2048);
    expect(existsSync(`${path}.1`)).toBe(true);
  } finally {
    if (prevDataDir === undefined) delete process.env.REGIMEN_DATA_DIR;
    else process.env.REGIMEN_DATA_DIR = prevDataDir;
    if (prevMax === undefined) delete process.env.REGIMEN_CAPTURE_LOG_MAX_BYTES;
    else process.env.REGIMEN_CAPTURE_LOG_MAX_BYTES = prevMax;
    rmSync(dir, { recursive: true, force: true });
  }
});
