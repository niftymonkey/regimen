/**
 * The golden set persistence: round-trip through a temp config directory, the
 * absent-file signal, and the malformed-file loud failure.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goldenPath,
  readGolden,
  writeGolden,
  type GoldenEntry,
} from "../src/judged/golden.ts";

function withConfigDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-golden-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an absent golden file reads as undefined", () => {
  withConfigDir((dir) => {
    expect(readGolden(dir)).toBeUndefined();
  });
});

test("writeGolden then readGolden round-trips the entries and their expectations", () => {
  withConfigDir((dir) => {
    const entries: GoldenEntry[] = [
      { sessionId: "aaa", expect: { outcome: "accomplished-cleanly" } },
      { sessionId: "bbb", expect: { engagement: "engaged" } },
      { sessionId: "ccc" },
    ];
    writeGolden(dir, entries);
    expect(readGolden(dir)).toEqual(entries);
  });
});

test("the golden file is golden.json, never the config-home env file", () => {
  withConfigDir((dir) => {
    expect(goldenPath(dir)).toBe(join(dir, "golden.json"));
  });
});

test("a malformed golden file is a loud parse error, not a silent empty set", () => {
  withConfigDir((dir) => {
    writeFileSync(goldenPath(dir), "{ not valid json");
    expect(() => readGolden(dir)).toThrow();
  });
});
