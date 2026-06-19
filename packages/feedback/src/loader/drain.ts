/**
 * The loader's drain operation: read every segment in the buffer, dispatch
 * each line through the translator registry, write events into the store,
 * quarantine anything we cannot trust enough to insert. Idempotency by
 * `event_hash` (the SQLite store's PRIMARY KEY) makes re-running drainBuffer
 * over the same buffer a no-op past the first run.
 */
import { readFileSync } from "node:fs";
import { isSealedSegment, listSegments } from "../../hooks/event-log.ts";
import type { Store } from "../store.ts";
import { dispatchLine } from "./translators/index.ts";

export interface DrainResult {
  readonly segments_read: number;
  readonly lines_read: number;
  readonly events_inserted: number;
  readonly events_already_present: number;
  readonly events_skipped: number;
  readonly quarantined: number;
  /**
   * Absolute paths of sealed segments read to EOF in this pass. Every event
   * in these segments is durably committed by the time `drainBuffer` returns,
   * so the caller may unlink them. `current.jsonl` is never listed: it is the
   * active segment and may still grow. STUB.
   */
  readonly drained_sealed: readonly string[];
}

export function drainBuffer(bufferDir: string, store: Store): DrainResult {
  const segments = listSegments(bufferDir);
  let lines_read = 0;
  let events_inserted = 0;
  let events_already_present = 0;
  let events_skipped = 0;
  let quarantined = 0;

  const drained_sealed: string[] = [];
  for (const segment of segments) {
    const content = readFileSync(segment, "utf8");
    if (isSealedSegment(segment)) drained_sealed.push(segment);
    for (const line of content.split("\n")) {
      if (line.length === 0) continue;
      lines_read += 1;
      const outcome = dispatchLine(line);
      if (outcome.kind === "event") {
        const { inserted } = store.insertEvent(outcome.event);
        if (inserted) events_inserted += 1;
        else events_already_present += 1;
      } else if (outcome.kind === "skip") {
        events_skipped += 1;
      } else {
        store.quarantine(line, outcome.reason);
        quarantined += 1;
      }
    }
  }

  return {
    segments_read: segments.length,
    lines_read,
    events_inserted,
    events_already_present,
    events_skipped,
    quarantined,
    drained_sealed,
  };
}
