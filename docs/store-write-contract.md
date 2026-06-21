# The store-write contract

Per ADR-0005, the Feedback buffer is an open-format seam: any producer can add events to the store by appending lines to the buffer, without importing Feedback's TypeScript. This document is that contract, so an external producer in another repo or runtime can write events Feedback will index correctly.

The motivating external producer is the Enforcement package's gate-denial emitter: a hook process that runs at the harness edge, cannot import Feedback's modules, and must record a `gate.denial` event so the evidence layer counts it. It writes across this seam. The conformance guard is `packages/feedback/tests/store-write-contract.test.ts`, which stands in for that external producer (it deliberately imports no Feedback builder) and fails loudly if the contract drifts.

## What a producer writes

One v1 event per line, as documented in `event-schema.md`, newline-terminated, appended to the buffer file. Two distinctions make a write conformant:

1. **No top-level `payload` key.** The loader decides per line: a line with a `payload` key is a capture-hook ENVELOPE (it gets routed through a harness translator); a line WITHOUT one is treated as an already-translated v1 event and validated structurally as-is. An external producer writes the v1 event directly, so it must not wrap it in an envelope.
2. **Schema-valid before it is written.** The line must satisfy `packages/feedback/schemas/event.schema.json`. A producer should validate against that schema itself; the loader quarantines anything that does not conform rather than corrupting the store.

## Where the buffer is

Resolve the data dir the documented way: honor `REGIMEN_DATA_DIR` when set, else the per-OS default data dir. The buffer is `<dataDir>/buffer/current.jsonl`. Create the directory first (`mkdir -p` semantics), then append one newline-terminated JSON object. Appends must use O_APPEND so concurrent producers never tear or clobber each other's lines (the buffer is single-writer-safe only under append-atomic writes).

## What the producer derives, and what it must not

- **Derive `trace_id`** as `event-schema.md` specifies: lowercase hex of `sha256("trace:" + session_id)`, first 32 characters. This must equal Feedback's own `traceIdFor(session_id)`; the conformance test asserts the equality so a change to the derivation fails loudly instead of silently orphaning external events into a different trace. Reimplement it with the runtime's own crypto (a Node-family producer uses `node:crypto`); do not import it.
- **Do NOT compute an `event_hash`.** The store derives the content hash and uses it for idempotency, so re-draining the same line inserts nothing the second time. A producer that invents its own hash field would be ignored at best and conflicting at worst.

## What the store does on drain

The loader drains the buffer, validates each line, and for a conformant v1-direct line inserts one row into `events`, then projects it into the derived tables and views: a `gate.denial` lands in `gate_denials` and increments `gate_denial_count` in the `conversation_counts` view, a `tool.pre`/`tool.post` pair becomes a tool span, and so on. Insertion is idempotent on the content hash: a restart or a re-drain of the same buffer inserts zero new rows.

## Worked example: a gate.denial line

```json
{
  "schema_version": 1,
  "timestamp": "2026-06-15T17:42:09.000Z",
  "session_id": "claude-external-producer-9f3a",
  "harness": "claude",
  "event_type": "gate.denial",
  "trace_id": "<sha256('trace:'+session_id) hex, first 32 chars>",
  "span_phase": "point",
  "span_name": "gate:rm-rf-guard",
  "attributes": {
    "gate_id": "rm-rf-guard",
    "tool_name": "Bash",
    "tool_call_id": "toolu_extprod01",
    "reason": "recursive forced rm denied"
  }
}
```

Appended as one line to `<dataDir>/buffer/current.jsonl`, this drains into `events`, `gate_denials`, and `conversation_counts` with no Feedback import on the producer side. The span name convention for a gate denial is `gate:<gate_id>`.
