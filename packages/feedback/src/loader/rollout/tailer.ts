/**
 * The Codex rollout tailer: the I/O shell around the pure rollout reader.
 *
 * Phase 1.4's polling follower of `CODEX_HOME/sessions/**\/*.jsonl`. It is
 * the version-proof fallback for builds where Codex hooks regress and the
 * judge-time transcript source. The newest rollout is the live conversation
 * and is read as open; every older rollout is a finished transcript and is
 * read complete, which is where the session.end boundary comes from (the
 * reader stamps it at the transcript's last timestamp). Per ADR-0006 the
 * tailer keeps no persisted offset: it leans on event-hash idempotency in
 * the store, so re-reading a file is a no-op past the first pass.
 *
 * The store is injected as a sink so the pure follow-and-translate logic is
 * tested with an array, and the daemon wires the sink to `store.insertEvent`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RegimenEvent } from "../../../hooks/event-log.ts";
import { rolloutRead, type QuarantinedRecord } from "./codex-reader.ts";

export type { QuarantinedRecord } from "./codex-reader.ts";

const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;

/**
 * Every rollout file under the sessions tree, sorted oldest-first. The
 * `rollout-<ISO8601>-<uuid>.jsonl` name sorts lexically into chronological
 * order, so the last entry is the newest (live) session.
 */
function rolloutFiles(sessionsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .filter((entry) => ROLLOUT_FILE.test(basename(entry)))
    .sort((a, b) => basename(a).localeCompare(basename(b)))
    .map((entry) => join(sessionsDir, entry));
}

export type RolloutSink = (event: RegimenEvent) => void;

/** A quarantined record and the file it came from, for surfacing. */
export type RolloutQuarantineSink = (
  record: QuarantinedRecord & { readonly file: string },
) => void;

/** The unknown-record-type counts a scan accumulated, for surfacing. */
export type RolloutUnknownTypesSink = (
  unknownRecordTypes: Record<string, number>,
) => void;

export interface RolloutTailerOptions {
  /** The Codex sessions root, e.g. `CODEX_HOME/sessions`. */
  readonly sessionsDir: string;
  /** Where translated events go; the daemon wires this to the store. */
  readonly sink: RolloutSink;
  /**
   * Where a malformed load-bearing record goes (ADR-0007): the daemon wires it
   * to `store.quarantine`. Omitted leaves quarantines unsurfaced, which the
   * pure tests exercise.
   */
  readonly onQuarantine?: RolloutQuarantineSink;
  /**
   * Where the unknown-record-type counts of a scan go: the daemon wires it to
   * the operational log so vendor drift is visible. Omitted leaves them
   * unsurfaced. Only non-empty maps are reported.
   */
  readonly onUnknownTypes?: RolloutUnknownTypesSink;
  /**
   * When set, scan on this cadence (milliseconds) until `stop`. Omitted (the
   * default) leaves the tailer manual: the caller drives it with `pollOnce`,
   * which is the unit the tests exercise. The polling interval is the
   * fallback's freshness mechanism, the way the daemon's file watcher is the
   * hook path's; DrvFs on the dev box has no reliable inotify, so the Mac
   * single-home case aside, polling is the portable choice (ADR-0006).
   */
  readonly intervalMs?: number;
}

export interface RolloutTailerHandle {
  /** Scan the sessions tree once and route every new event to the sink. */
  pollOnce(): void;
  /** Stop any scheduled polling. */
  stop(): void;
}

export function startRolloutTailer(
  options: RolloutTailerOptions,
): RolloutTailerHandle {
  const pollOnce = (): void => {
    const files = rolloutFiles(options.sessionsDir);
    const newest = files.length > 0 ? files[files.length - 1] : undefined;
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const result = rolloutRead(content, { complete: file !== newest });
      for (const event of result.events) {
        options.sink(event);
      }
      if (options.onQuarantine !== undefined) {
        for (const record of result.quarantined) {
          options.onQuarantine({ ...record, file });
        }
      }
      if (
        options.onUnknownTypes !== undefined &&
        Object.keys(result.unknownRecordTypes).length > 0
      ) {
        options.onUnknownTypes(result.unknownRecordTypes);
      }
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (options.intervalMs !== undefined) {
    timer = setInterval(pollOnce, options.intervalMs);
  }

  return {
    pollOnce,
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
