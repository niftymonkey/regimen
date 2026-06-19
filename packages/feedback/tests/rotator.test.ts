/**
 * Buffer rotation: `rotateIfNeeded` seals `current.jsonl` once it crosses a
 * size or age threshold, leaving a `sealed-<rfc3339>.jsonl` segment and no
 * `current.jsonl`. These tests build a real temp buffer dir and exercise the
 * public contract; the clock and the rename syscall are injected so the age
 * threshold and the Windows-collision retry are testable without waiting an
 * hour or running on Windows.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSealedSegment } from "../hooks/event-log.ts";
import { rotateIfNeeded } from "../src/loader/rotator.ts";

function withBuffer(fn: (bufferDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "regimen-rotator-"));
  const bufferDir = join(root, "buffer");
  mkdirSync(bufferDir, { recursive: true });
  try {
    fn(bufferDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeCurrent(bufferDir: string, content: string): void {
  writeFileSync(join(bufferDir, "current.jsonl"), content);
}

function sealedNames(bufferDir: string): string[] {
  return readdirSync(bufferDir).filter(isSealedSegment);
}

test("R1: a current.jsonl over the size threshold is sealed", () => {
  withBuffer((bufferDir) => {
    writeCurrent(bufferDir, "x".repeat(2048));

    const outcome = rotateIfNeeded({ bufferDir, maxBytes: 1024 });

    expect(outcome.kind).toBe("rotated");
    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(false);
    const sealed = sealedNames(bufferDir);
    expect(sealed.length).toBe(1);
    expect(outcome.sealed).toBe(join(bufferDir, sealed[0]!));
    expect(readFileSync(outcome.sealed!, "utf8")).toBe("x".repeat(2048));
  });
});

test("R2: a current.jsonl under both thresholds is left alone", () => {
  withBuffer((bufferDir) => {
    writeCurrent(bufferDir, "x".repeat(100));

    const outcome = rotateIfNeeded({ bufferDir, maxBytes: 1024 });

    expect(outcome.kind).toBe("no-op");
    expect(outcome.reason).toBe("below-threshold");
    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(true);
    expect(sealedNames(bufferDir).length).toBe(0);
  });
});

test("R3: a current.jsonl older than the age threshold is sealed", () => {
  withBuffer((bufferDir) => {
    writeCurrent(bufferDir, "x".repeat(100));
    const farFuture = Date.now() + 1_000_000;

    const outcome = rotateIfNeeded({
      bufferDir,
      maxBytes: 1_000_000,
      maxAgeMs: 1000,
      now: () => farFuture,
    });

    expect(outcome.kind).toBe("rotated");
    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(false);
    expect(sealedNames(bufferDir).length).toBe(1);
  });
});

test("R4: an absent current.jsonl is a no-op, not an error", () => {
  withBuffer((bufferDir) => {
    const outcome = rotateIfNeeded({ bufferDir, maxBytes: 1024 });

    expect(outcome.kind).toBe("no-op");
    expect(outcome.reason).toBe("current-missing");
    expect(sealedNames(bufferDir).length).toBe(0);
  });
});

/** A rename that throws EBUSY for its first `failures` calls, then succeeds. */
function flakyRename(failures: number): {
  rename: (from: string, to: string) => void;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempts: () => attempts,
    rename(from, to) {
      attempts += 1;
      if (attempts <= failures) {
        const err = new Error("EBUSY: resource busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      renameSync(from, to);
    },
  };
}

test("R5: a rename that fails transiently is retried until it succeeds", () => {
  withBuffer((bufferDir) => {
    writeCurrent(bufferDir, "x".repeat(2048));
    const flaky = flakyRename(2);

    const outcome = rotateIfNeeded({
      bufferDir,
      maxBytes: 1024,
      retryDelaysMs: [1, 1, 1],
      rename: flaky.rename,
    });

    expect(outcome.kind).toBe("rotated");
    expect(flaky.attempts()).toBe(3);
    expect(sealedNames(bufferDir).length).toBe(1);
  });
});

test("R6: a rename that never succeeds returns failed without throwing", () => {
  withBuffer((bufferDir) => {
    writeCurrent(bufferDir, "x".repeat(2048));
    const flaky = flakyRename(99);

    const outcome = rotateIfNeeded({
      bufferDir,
      maxBytes: 1024,
      retryDelaysMs: [1, 1],
      rename: flaky.rename,
    });

    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toBe("rename-failed-persistently");
    expect(flaky.attempts()).toBe(3);
    expect(existsSync(join(bufferDir, "current.jsonl"))).toBe(true);
    expect(sealedNames(bufferDir).length).toBe(0);
  });
});
