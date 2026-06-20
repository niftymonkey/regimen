/**
 * The harness-neutral transcript reader contract: the result, options, and
 * anchor types every harness reader produces and the judge path consumes.
 *
 * These types describe what a `TranscriptReader` returns, independent of which
 * harness produced the transcript. They lived in the Codex reader module while
 * Codex was the only reader; with a second reader (Claude) behind the same
 * ports, their home there became misleading. They reference only `RegimenEvent`
 * (the v1 event vocabulary), never any vendor format, so they belong in a
 * neutral module the ports, the Codex reader, and the Claude reader all import.
 */
import type { RegimenEvent } from "../../hooks/event-log.ts";

/**
 * A reference from a content chunk back to the deterministic event that
 * justifies it, per ADR-0008. A tool chunk resolves through the
 * `tool_call_spans` PK; every other chunk resolves through the lowercase-hex
 * encoding of its structural event's `event_hash`.
 */
export type AnchorRef =
  | { readonly eventHash: string }
  | { readonly sessionId: string; readonly toolCallId: string };

/**
 * One unit of conversation text the judge reads, referenced by anchor and
 * never stored in the events DB. `text` is already extracted, filtered, and
 * truncated. `lineSeq` is the chunk's position in file line order, the
 * re-render-stable ordering key (timestamps collide; line order does not).
 */
export interface ContentChunk {
  readonly kind:
    | "human_prompt"
    | "assistant_answer"
    | "tool_args"
    | "tool_output"
    | "web_search_query";
  readonly text: string;
  readonly anchor: AnchorRef;
  readonly lineSeq: number;
}

export interface RolloutReadOptions {
  /**
   * When true, the transcript is treated as finished and a `session.end` is
   * appended at the last line's timestamp. The newest live rollout passes
   * false so an open conversation is never force-closed.
   */
  readonly complete: boolean;
}

/**
 * A load-bearing record the reader recognized but could not parse to a shape
 * it trusts, surfaced rather than best-effort parsed (ADR-0007). `rawLine` is
 * the verbatim JSONL line so a caller can route it to the quarantine store.
 */
export interface QuarantinedRecord {
  readonly reason: string;
  readonly rawLine: string;
}

/**
 * One whole-transcript read: the structural events, the content projection,
 * and the ADR-0007 fail-closed diagnostics. `unknownRecordTypes` counts each
 * record shape the reader has never seen, keyed by a reader-defined key, so
 * benign vendor drift stays visible without failing a readable transcript.
 * `quarantined` holds load-bearing records whose fields did not match a known
 * shape (an unknown message role, an unknown content-part type).
 */
export interface RolloutReadResult {
  readonly events: RegimenEvent[];
  readonly content: ContentChunk[];
  readonly unknownRecordTypes: Record<string, number>;
  readonly quarantined: QuarantinedRecord[];
}
