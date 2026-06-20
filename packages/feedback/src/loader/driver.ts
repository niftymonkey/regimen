/**
 * The loader's foreground driver: the long-running loop ADR-0006 names as
 * the "opt-in always-on daemon" in foreground form. The driver owns the
 * cycle cadence: one initial cycle, then one debounced cycle per burst of
 * buffer-change signals from the watcher. Each cycle drains the buffer,
 * unlinks any sealed segment it consumed, and rotates `current.jsonl` when
 * it crosses a size or age threshold; a rotation schedules a follow-up
 * cycle so the freshly sealed segment is drained promptly. Per ADR-0006 the
 * watcher is the only OS-specific seam in this loop; chokidar lives in
 * `run.ts` so the driver itself is pure and synthetic watchers can drive it
 * in tests.
 */
import { rmSync } from "node:fs";
import { drainBuffer, type DrainResult } from "./drain.ts";
import { rotateIfNeeded, type RotatorOptions } from "./rotator.ts";
import type { Store } from "../store.ts";

/**
 * The buffer-change source the driver listens on. Implementations:
 *   - `chokidarWatcher` in `run.ts`, the production source.
 *   - Any test fake: an object with `onChange` and `close`.
 */
export interface BufferWatcher {
  onChange(listener: () => void): void;
  close(): void | Promise<void>;
}

export interface DriverOptions {
  readonly bufferDir: string;
  readonly store: Store;
  readonly watcher: BufferWatcher;
  /** Coalesce-window for buffer-change bursts. Default 50ms. */
  readonly debounceMs?: number;
  /** Called after every drain, with the result. */
  readonly onDrain?: (result: DrainResult) => void;
  /**
   * Called after the driver seals a buffer segment, with that segment's
   * absolute path. The daemon wires this to its operational log so a
   * rotation shows up in `daemon.log`.
   */
  readonly onRotate?: (sealed: string) => void;
  /**
   * Buffer-rotation thresholds, checked after every drain. Omitted fields
   * fall back to the rotator's defaults (4 MB / 1 hour); an omitted
   * `rotation` still rotates on those defaults.
   */
  readonly rotation?: Omit<RotatorOptions, "bufferDir">;
  /**
   * The enabled-flag gate the daemon honors per ADR-0006. When provided, the
   * driver polls `isEnabled` on `intervalMs` (default 2000); the first time
   * the call returns false, `onDisabled` is invoked exactly once and the poll
   * stops. The caller wires `onDisabled` to its shutdown path.
   */
  readonly flagPoll?: {
    isEnabled: () => boolean;
    intervalMs?: number;
    onDisabled: () => void;
  };
}

export interface DriverHandle {
  /** Resolves when any in-flight or pending drain has finished and the watcher is closed. */
  shutdown(): Promise<void>;
}

export function startDriver(opts: DriverOptions): DriverHandle {
  const debounceMs = opts.debounceMs ?? 50;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const runCycle = (): void => {
    const result = drainBuffer(opts.bufferDir, opts.store);
    for (const sealed of result.drained_sealed) {
      rmSync(sealed, { force: true });
    }
    opts.onDrain?.(result);
    const rotation = rotateIfNeeded({
      bufferDir: opts.bufferDir,
      ...opts.rotation,
    });
    if (rotation.kind === "rotated") {
      if (rotation.sealed !== undefined) opts.onRotate?.(rotation.sealed);
      scheduleCycle();
    }
  };

  const scheduleCycle = (): void => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      runCycle();
    }, debounceMs);
  };

  let flagTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.flagPoll !== undefined) {
    const { isEnabled, onDisabled } = opts.flagPoll;
    const intervalMs = opts.flagPoll.intervalMs ?? 2000;
    flagTimer = setInterval(() => {
      if (isEnabled()) return;
      if (flagTimer !== null) {
        clearInterval(flagTimer);
        flagTimer = null;
      }
      onDisabled();
    }, intervalMs);
  }

  opts.watcher.onChange(scheduleCycle);
  runCycle();

  return {
    async shutdown(): Promise<void> {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (flagTimer !== null) {
        clearInterval(flagTimer);
        flagTimer = null;
      }
      await opts.watcher.close();
    },
  };
}
