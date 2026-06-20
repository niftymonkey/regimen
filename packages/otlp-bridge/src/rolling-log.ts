/**
 * Size-bounded rolling for the bridge's append-only log file.
 *
 * `<dataDir>/bridge.log` is a plain append-only file that would otherwise
 * grow without limit for as long as the bridge daemon runs. This primitive
 * bounds it: once the file reaches a byte cap it is rolled to `<path>.1`, the
 * prior `.1` shifts to `.2`, and so on, with copies past `keep` discarded.
 * The next append re-creates `path`.
 *
 * `rollIfOversize` is a pure decision: it re-reads the file system on every
 * call and holds no inter-call state. It is best-effort and never throws, so
 * a logging path can call it without a guard of its own. It is ported from
 * the feedback package's primitive of the same name, which bounds that
 * instrument's daemon log the same way.
 */
import { renameSync, rmSync, statSync } from "node:fs";

export interface RollOptions {
  /** Roll once the file reaches this many bytes. */
  readonly maxBytes: number;
  /** Rolled copies to retain: `<path>.1` through `<path>.<keep>`. */
  readonly keep: number;
}

export interface RollOutcome {
  /** Whether the file had reached the cap and was rolled. */
  readonly rolled: boolean;
}

/**
 * Roll `path` if it has reached `opts.maxBytes`, retaining `opts.keep` rolled
 * copies. A missing file, a file below the cap, or any file-system failure is
 * a no-op that returns `{ rolled: false }`.
 */
export function rollIfOversize(path: string, opts: RollOptions): RollOutcome {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { rolled: false };
  }
  if (size < opts.maxBytes) return { rolled: false };

  try {
    rmSync(`${path}.${opts.keep}`, { force: true });
    for (let i = opts.keep - 1; i >= 1; i -= 1) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {
        // This rolled position is empty until the file has rolled that many
        // times; shifting the remaining copies still holds.
      }
    }
    renameSync(path, `${path}.1`);
    return { rolled: true };
  } catch {
    return { rolled: false };
  }
}
