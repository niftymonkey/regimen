/**
 * Per-signal-stream watermarks: the bridge's durability record.
 *
 * Each of the three OTLP signal streams (logs, metrics, traces) advances an
 * independent timestamp watermark. The Source reads a stream's watermark to
 * decide what to pull next; the Exporter commits a new watermark only after a
 * batch is delivered, so a crash resumes from the last delivered position.
 * Streams advance independently: a slow exporter on one does not pin another.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The three OTLP signal streams the bridge exports, each watermarked apart. */
export type SignalStream = "logs" | "metrics" | "traces";

export interface WatermarkStore {
  /** The last committed watermark for `stream`, or null if none committed. */
  read(stream: SignalStream): string | null;
  /** Record `watermark` as the new high-water mark for `stream`. */
  commit(stream: SignalStream, watermark: string): void;
}

/**
 * Load the watermark map from disk. An absent or unreadable file (never
 * written, or torn by an interrupted write) reads as an empty map, so the
 * caller resumes from no watermark rather than crashing.
 */
function load(filePath: string): Partial<Record<SignalStream, string>> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Partial<
      Record<SignalStream, string>
    >;
  } catch {
    return {};
  }
}

/**
 * Open the watermark store backed by the JSON file at `filePath`. The file is
 * created on first commit; an absent or unreadable file reads as no watermarks.
 */
export function openWatermarkStore(filePath: string): WatermarkStore {
  // Ensure the containing directory exists so `commit` cannot fail with
  // ENOENT; the watermark file lives under a `bridge/` subdirectory that the
  // loader does not create.
  mkdirSync(dirname(filePath), { recursive: true });
  return {
    read(stream: SignalStream): string | null {
      return load(filePath)[stream] ?? null;
    },
    commit(stream: SignalStream, watermark: string): void {
      const marks = load(filePath);
      marks[stream] = watermark;
      // Write to a sidecar then rename: rename is atomic on one filesystem,
      // so a reader never observes a half-written watermark file.
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(marks));
      renameSync(tmp, filePath);
    },
  };
}

/**
 * A watermark store held only in memory. A dry run uses it so it never
 * mutates the persisted watermark file: a preview must not advance the state
 * that a later real run resumes from.
 */
export function memoryWatermarkStore(): WatermarkStore {
  const marks = new Map<SignalStream, string>();
  return {
    read(stream: SignalStream): string | null {
      return marks.get(stream) ?? null;
    },
    commit(stream: SignalStream, watermark: string): void {
      marks.set(stream, watermark);
    },
  };
}
