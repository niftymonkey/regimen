import { renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Buffer rotation for the Feedback loader daemon.
 *
 * Per ADR-0006 the daemon bounds `current.jsonl` by size or age: when the
 * active segment crosses a threshold it is atomically renamed to a
 * `sealed-<rfc3339>.jsonl` segment, and the next hook append re-creates a
 * fresh `current.jsonl`. Rotation is not load-bearing for correctness, since
 * event-hash idempotency absorbs any replay; it exists only to keep restart
 * recovery fast. `rotateIfNeeded` is a pure decision: it re-reads the file
 * system on every call and holds no inter-call state.
 */

export interface RotatorOptions {
  /** The buffer directory holding `current.jsonl` and sealed segments. */
  readonly bufferDir: string;
  /** Rotate once `current.jsonl` reaches this size. Default 4_000_000. */
  readonly maxBytes?: number;
  /** Rotate once `current.jsonl` is this old. Default 3_600_000 (1 hr). */
  readonly maxAgeMs?: number;
  /** Injectable clock; default `Date.now`. */
  readonly now?: () => number;
  /**
   * Backoff schedule for a rename that collides with an in-flight hook on
   * Windows. Each entry is a millisecond pause before the next attempt.
   * Default `[50, 200, 500, 1000]`.
   */
  readonly retryDelaysMs?: readonly number[];
  /** Injectable rename; default `renameSync`. The Windows-collision seam. */
  readonly rename?: (from: string, to: string) => void;
}

export type RotateReason =
  | "below-threshold"
  | "current-missing"
  | "rename-failed-persistently";

export interface RotateOutcome {
  readonly kind: "rotated" | "no-op" | "failed";
  /** Absolute path of the new sealed segment, when `kind === "rotated"`. */
  readonly sealed?: string;
  readonly reason?: RotateReason;
}

/** The filesystem-safe `sealed-<rfc3339>.jsonl` segment name for an instant. */
function sealedName(ms: number): string {
  return `sealed-${new Date(ms).toISOString().replace(/[:.]/g, "-")}.jsonl`;
}

/**
 * Seal `current.jsonl` if it has crossed the size or age threshold.
 */
export function rotateIfNeeded(opts: RotatorOptions): RotateOutcome {
  const maxBytes = opts.maxBytes ?? 4_000_000;
  const maxAgeMs = opts.maxAgeMs ?? 3_600_000;
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const currentPath = join(opts.bufferDir, "current.jsonl");
  let stat;
  try {
    stat = statSync(currentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "no-op", reason: "current-missing" };
    }
    throw err;
  }
  const ageMs = nowMs - stat.mtimeMs;
  if (stat.size < maxBytes && ageMs < maxAgeMs) {
    return { kind: "no-op", reason: "below-threshold" };
  }
  const sealedPath = join(opts.bufferDir, sealedName(nowMs));
  const rename = opts.rename ?? renameSync;
  const retryDelaysMs = opts.retryDelaysMs ?? [50, 200, 500, 1000];

  const attemptRename = (): boolean => {
    try {
      rename(currentPath, sealedPath);
      return true;
    } catch {
      return false;
    }
  };

  let renamed = attemptRename();
  for (const delay of retryDelaysMs) {
    if (renamed) break;
    Bun.sleepSync(delay);
    renamed = attemptRename();
  }
  if (!renamed) {
    return { kind: "failed", reason: "rename-failed-persistently" };
  }
  return { kind: "rotated", sealed: sealedPath };
}
