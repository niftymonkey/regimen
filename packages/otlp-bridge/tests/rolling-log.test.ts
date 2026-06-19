/**
 * `rollIfOversize` bounds an append-only log file: at or over the byte cap it
 * shifts `<path>` to `<path>.1`, the prior copies up the chain, and drops
 * everything past `keep`. These tests build a real temp directory and assert
 * the public contract; the local file system is the test substrate.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollIfOversize } from "../src/rolling-log.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-rolling-log-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("L1: a file under the size cap is left alone", () => {
  withDir((dir) => {
    const path = join(dir, "bridge.log");
    writeFileSync(path, "x".repeat(100));

    const outcome = rollIfOversize(path, { maxBytes: 1024, keep: 3 });

    expect(outcome.rolled).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(false);
  });
});

test("L2: a file at or over the size cap is rolled to .1", () => {
  withDir((dir) => {
    const path = join(dir, "bridge.log");
    writeFileSync(path, "x".repeat(2048));

    const outcome = rollIfOversize(path, { maxBytes: 1024, keep: 3 });

    expect(outcome.rolled).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(2048));
  });
});

test("L3: a missing file is a no-op, not an error", () => {
  withDir((dir) => {
    const outcome = rollIfOversize(join(dir, "bridge.log"), {
      maxBytes: 1024,
      keep: 3,
    });

    expect(outcome.rolled).toBe(false);
  });
});

test("L4: rolled copies past keep are discarded", () => {
  withDir((dir) => {
    const path = join(dir, "bridge.log");
    for (const marker of ["first", "second", "third"]) {
      writeFileSync(path, marker.repeat(500));
      rollIfOversize(path, { maxBytes: 1024, keep: 2 });
    }

    expect(readFileSync(`${path}.1`, "utf8")).toBe("third".repeat(500));
    expect(readFileSync(`${path}.2`, "utf8")).toBe("second".repeat(500));
    expect(existsSync(`${path}.3`)).toBe(false);
  });
});

test("L5: repeated rolls keep newest at .1 and oldest at .keep", () => {
  withDir((dir) => {
    const path = join(dir, "bridge.log");
    for (const marker of ["a", "b", "c"]) {
      writeFileSync(path, marker.repeat(2000));
      rollIfOversize(path, { maxBytes: 1024, keep: 3 });
    }

    expect(readFileSync(`${path}.1`, "utf8")).toBe("c".repeat(2000));
    expect(readFileSync(`${path}.2`, "utf8")).toBe("b".repeat(2000));
    expect(readFileSync(`${path}.3`, "utf8")).toBe("a".repeat(2000));
  });
});
