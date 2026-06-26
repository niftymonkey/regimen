# Store-write contract

How an out-of-process producer records an event in Feedback's store without importing any Feedback code. The producer appends one JSON line to Feedback's open-format buffer; Feedback's loader drains that line into SQLite. This is the published external-producer seam: the buffer is an open format ([ADR-0005](../../../docs/adr/0005-feedback-data-architecture.md)), so any process that can write a file in the documented place, in the documented shape, gets its events recorded, whatever language it is written in and whatever harness it runs under.

This document does not restate the event field contract. The field-level shape is [`schemas/event.schema.json`](../schemas/event.schema.json) and the prose behind it is [`docs/event-schema.md`](./event-schema.md). This document publishes the four things those do not: WHERE to write, the DISPATCH rule that selects the producer's line shape, the exact `trace_id` derivation, and the append and idempotency semantics. A conformance test ([`tests/store-write-contract.test.ts`](../tests/store-write-contract.test.ts)) guards every claim here against the running loader.

## Purpose and scope

An event producer that lives in Feedback's own process (the capture hook) appends to the buffer through Feedback's TypeScript modules. A producer in a separate process cannot import those modules and must not. This contract is for that producer: it writes across the open-format seam, not through an in-process import.

This seam is a general production interface, available to any future out-of-process producer; it is not specific to any one event type. Its first and only producer was the enforcement package's gate-denial emitter, which [ADR-0014](../../../docs/adr/0014-enforcement-drops-the-gate-denial-emit-seam.md) removed: a gate denial is already captured in the harness transcript, so a self-reported store event was redundant. The contract therefore currently has no active producer, but the seam itself survives by design, ready for the next producer that has a genuine deterministic signal to record. The reasoning that established the seam still holds: ADR-0009 records that an out-of-process write path must be a documented store-write contract over the ADR-0005 open-format seam, so a producer writes across the seam rather than through an import.

The scope is one direction only: a producer appending events. Reading the store, draining the buffer, sealing and rotating segments, and computing signals are Feedback's concerns and are not part of this contract.

## Where to write

A producer resolves the buffer file in two steps: resolve Feedback's data directory, then append to `<dataDir>/buffer/current.jsonl`.

### Data-directory resolution

Resolve the data directory from the environment and the operating system, in this order. This is exactly what Feedback's own `resolveDataDir` ([`src/data-dir.ts`](../src/data-dir.ts)) does, and a producer must reproduce it so it writes to the same directory Feedback reads.

1. If the `REGIMEN_DATA_DIR` environment variable is set to a non-empty string, that is the data directory. This override wins on every platform and is how tests point Feedback at a temporary directory.
2. Otherwise, dispatch on the operating system:
   - **Linux:** if `XDG_DATA_HOME` is set to a non-empty string, the data directory is `<XDG_DATA_HOME>/regimen`. Otherwise, if `HOME` is set, it is `<HOME>/.local/share/regimen`.
   - **macOS (`darwin`):** if `HOME` is set, the data directory is `<HOME>/Library/Application Support/regimen`.
   - **Windows (`win32`):** if `APPDATA` is set to a non-empty string, the data directory is `<APPDATA>\regimen`.
3. If none of the above resolves (an unsupported platform, or the expected environment variable absent), the producer cannot resolve a data directory. Set `REGIMEN_DATA_DIR` to override. A producer that fails to resolve must fail safe (see "Append and idempotency"), never guess a path.

The application directory name is always `regimen`. On Windows the path is joined with backslashes; on Linux and macOS with forward slashes.

### The buffer file

The buffer directory is `<dataDir>/buffer`. Within it:

- `current.jsonl` is the active segment. **Producers always append here.**
- `sealed-<rfc3339>.jsonl` segments are sealed, rotated-out history. These are loader-managed: Feedback rotates `current.jsonl` into a sealed segment when it grows past its size cap, and drains and unlinks sealed segments. A producer never writes a sealed segment and never names one.

So the single target for every external producer is `<dataDir>/buffer/current.jsonl`.

## What to write

One event is one JSON object on one line: UTF-8 encoded, serialized with no embedded newlines, terminated by a single `\n`. A producer appends one such line per event.

### The two line shapes and the dispatch rule

The loader reads each buffer line and routes it by one rule: the presence or absence of a top-level `payload` key (`dispatchLine` in [`src/loader/translators/index.ts`](../src/loader/translators/index.ts)).

- **With a top-level `payload` key:** the line is an envelope, `{ harness, captured_at, payload }`, wrapping a raw harness hook payload. The loader looks up the per-harness translator and narrows the raw payload to a canonical v1 event. This is the capture hook's path.
- **Without a top-level `payload` key:** the line is treated as an already-translated v1 event. The loader validates it structurally (`validateV1Event` in [`src/loader/translators/v1.ts`](../src/loader/translators/v1.ts)) and inserts it as-is.

A harness-agnostic out-of-process producer writes the **v1-direct form: a complete v1 event object with no `payload` key.** It does not write an envelope.

The reason: a synthetic, cross-harness signal is not a harness hook payload. A `tool.pre` or `session.start` originates as a native hook event a translator narrows, so it rides the envelope path. A signal with no native hook event behind it is minted directly by the producer. Routing it through a per-harness translator would be wrong twice over: there is nothing harness-native to translate, and it would couple a harness-agnostic event to a per-harness code path. So an out-of-process producer mints the canonical v1 event directly and the loader inserts it without translation.

### The v1-direct event shape

A producer writes a complete v1 event. The field-level shape is in [`schemas/event.schema.json`](../schemas/event.schema.json); every v1 event carries `schema_version` (the integer `1`), `timestamp` (RFC 3339 in UTC), `session_id` (the harness's own session id), `harness` (one of the normalized harness identifiers in the schema's enum), `event_type` (one of the schema's event types), `span_phase`, `span_name`, an `attributes` object, the derived `trace_id` (see below), and an optional `model`. See [`schemas/event.schema.json`](../schemas/event.schema.json) and [`docs/event-schema.md`](./event-schema.md) for every field's type and intent.

## The trace_id derivation

`trace_id` groups every event of one session into one trace. A producer's event must land in the same trace as the session's capture events, so the producer must derive `trace_id` the same way Feedback does. The derivation is **frozen** and must be reproduced exactly:

> `trace_id` is the SHA-256 digest of the UTF-8 string `"trace:" + session_id`, taken as a lowercase hex string, truncated to the first 32 characters.

In Feedback this is `traceIdFor` in [`hooks/event-log.ts`](../hooks/event-log.ts). An external producer reimplements it in its own language. For example, in a Node-family runtime:

```ts
import { createHash } from "node:crypto";

function traceIdFor(sessionId: string): string {
  return createHash("sha256")
    .update(`trace:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}
```

The 32-character truncation is OTLP-native trace-id width (16 bytes as 32 hex characters). Because the derivation is a pure function of `session_id`, every producer that reproduces it lands its events under the same trace, whichever process emitted them. If the producer derives `trace_id` differently, its event is silently orphaned into a different trace; nothing rejects it, so reproducing this derivation exactly is the producer's responsibility. The conformance test asserts the externally-derived `trace_id` equals Feedback's `traceIdFor`, so any future change to the derivation fails loudly and signals that this published contract must be revised.

## Append and idempotency

A producer records one event with these semantics:

- **Create the buffer directory first.** `mkdir -p` the buffer directory (`<dataDir>/buffer`) before the first append; it may not exist yet on a fresh install.
- **Append one line.** Open `current.jsonl` for append and write one newline-terminated JSON line. Appending a single line is the only write a producer performs.
- **Never block or fail the producer's primary job on a write error.** Recording an event is secondary to whatever the producer's primary job is. If resolving the data directory, creating the directory, or appending the line fails, the producer swallows the error and continues. A recording failure must never surface to the session.
- **Do not compute `event_hash`.** The store computes the primary key itself: a SHA-256 over the event's canonical JSON ([`src/hash.ts`](../src/hash.ts)). The producer writes only the event fields. Idempotency is automatic: the store inserts with `INSERT OR IGNORE` keyed on that hash, so the same event appended twice (a retry, a replayed segment) is inserted once.
- **Concurrent appends are safe.** The buffer is append-only and line-oriented: each producer appends whole lines and never rewrites existing bytes, so independent producers (the capture hook and any out-of-process producer) can append concurrently without coordinating.

## Stability and versioning

This is a published seam. For `schema_version` 1, the following are **frozen**, and changing any of them is a contract revision, not an additive change:

- the buffer location (the data-directory resolution algorithm and the `<dataDir>/buffer/current.jsonl` target),
- the dispatch rule (a line with no top-level `payload` key is a v1-direct event), and
- the `trace_id` derivation.

The event field shape itself versions through `schema_version` as [`docs/event-schema.md`](./event-schema.md) ("Versioning") describes: additive field and event-type changes keep the version, breaking changes bump it. The conformance test ([`tests/store-write-contract.test.ts`](../tests/store-write-contract.test.ts)) guards the frozen seam by acting as an external producer end to end, so a change to any frozen part of this contract breaks the test rather than silently orphaning every external producer's events.

## Worked example

One complete v1-direct line, as an external producer would append it to `current.jsonl` (shown formatted; on the wire it is one line with no embedded newlines, terminated by `\n`). The event type below is `user_prompt` purely as a concrete, currently-valid example; the seam serves any v1 event type a producer has reason to write:

```json
{
  "schema_version": 1,
  "timestamp": "2026-06-15T17:42:09.000Z",
  "session_id": "claude-session-9f3a",
  "harness": "claude",
  "event_type": "user_prompt",
  "trace_id": "7e2338f03062a008a2f9a90e125d7ec9",
  "span_phase": "point",
  "span_name": "user_prompt",
  "attributes": {}
}
```

Here `trace_id` is `traceIdFor("claude-session-9f3a")`: SHA-256 of `"trace:claude-session-9f3a"`, hex, first 32 characters. The producer writes the object above and nothing else; the store computes `event_hash` and inserts the row.
