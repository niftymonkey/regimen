/**
 * The bridge's private path helpers on top of the Regimen data directory.
 *
 * The bridge reads `feedback.db` from the same OS-resolved directory the loader
 * writes it to (ADR-0006). It resolves that directory with the shared resolver
 * (`@regimen/shared`) so the two agree by construction, and re-exports it here
 * so the bridge's own callers keep their `./data-dir.ts` import surface.
 *
 * The bridge keeps its own watermark state under a `bridge/` subdirectory of
 * the same data directory, so it never writes `feedback.db` or the buffer.
 */
import { join as joinPath } from "node:path";
import { resolveDataDir, dataDir } from "@regimen/shared";

export { resolveDataDir, dataDir };

/** The Feedback SQLite store the bridge reads. */
export function feedbackDbPath(dir: string): string {
  return joinPath(dir, "feedback.db");
}

/** The bridge's own watermark file, under a `bridge/` subdirectory. */
export function watermarkPath(dir: string): string {
  return joinPath(dir, "bridge", "watermarks.json");
}

/** The bridge's own operational log, which it owns and size-bounds itself. */
export function bridgeLogPath(dir: string): string {
  return joinPath(dir, "bridge.log");
}
