# Enforcement drops the gate.denial emit seam; a gate denial is already captured in the transcript

> Status: accepted (2026-06-25)

Enforcement gates previously did two things when a gate denied a tool call: they wrote the deny decision back to the harness (the actual enforcement), and they also emitted a `gate.denial` event into Feedback's SQLite store through a dedicated seam (`packages/enforcement/src/denial-store.ts` plus `packages/enforcement/hooks/emit-denial.ts`), writing across the open-format store-write contract of ADR-0005. This ADR removes the second thing. The emit seam, its `gate.denial` event type, and every Feedback and bridge producer that read it are deleted. Gates still deny exactly as before; they simply no longer spawn an emitter to self-report the denial. The justification for the emit seam, that a gate denial is a discrete real-time act with no transcript footprint and so must self-report to become Feedback evidence, was empirically falsified, and with it gone Enforcement validates the same way Guidance does: the LLM judge reads the denial from the conversation Feedback already captures.

## Why the no-footprint premise did not hold

The emit seam rested on the claim that a denial leaves no trace the judge could later read, so a fired gate had to push a record into the store itself. A dual-headed investigation (two independent agents, one reasoning from the architecture and one from a minimal-surface lens) confirmed the opposite. A gate denial lands in the harness's own transcript as an `is_error` tool-result carrying the deny reason, and Feedback's per-harness transcript readers (the Claude reader and the Codex reader) already project that result to a judge-visible content chunk. One agent located the user's own em-dash-gate denial sitting in a real captured transcript, and roughly 129 such denial records across the local corpus. The denial was never footprint-free; it was captured the whole time. The emit seam was therefore manufacturing a redundant second copy of telemetry capture already holds, which is exactly the duplication ADR-0005 rejected when it kept conversation content out of the store and read it from the harness transcript on demand.

## The consequence: the two levers become structurally symmetric

With the emit seam gone, Enforcement validates exactly the way Guidance does. The beat-3 validate move (per ADR-0013 and `../mental-model.md`) is the same on both levers: re-run the Feedback read and let the judge, reading the captured conversation, say whether the recurring pattern abated. Nothing about a denial needs to be self-reported for the loop to close, because the denial is in the conversation the judge already reads. This makes the two response levers the same species of artifact: an act-beat operator skill plus a slim install facade that reuses a shared planner and bundler, with no emit seam on either side. The earlier framing that called the emit seam "the package's reason to exist as a separate package" is retired; the Enforcement package's reason to be its own package is its own act-beat operator skill and the gate-wiring concern, not emit.

## What is lost, and why that is accepted

What the drop forfeits is a deterministic firing count. The `gate.denial` event was the one source for the `feedback evidence` digest's `gateDenials` / `gateDenialCount` field and for the OTLP bridge's `regimen.gate.denials` metric; both lose their producer. The judge can read that a denial happened and reason about whether the pattern abated, but a plain count of how many times a gate fired is no longer derivable from the store. The user accepted this loss for three reasons: the OTLP dashboard is not live (the bridge compose is deferred), the seam is re-addable later if a genuine count need emerges, and only historical backfill is forfeited (a re-added seam captures counts from that point forward, and the conversations themselves remain on disk for the judge regardless).

## Scope and blast radius

The drop removes the `gate.denial` producer chain across three packages, while leaving every gate's deny behavior untouched.

- **`packages/enforcement`** deletes `src/denial-store.ts` and `hooks/emit-denial.ts`. Authored and wired gates still inspect the pending tool call and write the deny decision; they no longer spawn an emitter on a hit.
- **`packages/feedback`** removes the now-dead `gate.denial` producers: the `gate.denial` event type, the `gate_denials` table, the `gateDenials` / `gateDenialCount` fields on the evidence digest, the `gate.denial` branch in the projections, the v1 translator entry for the event, the `denied_by_gate_id` span marker, and the `gateDenials` line in the bundled `regimen-evidence` skill.
- **`packages/otlp-bridge`** drops the `regimen.gate.denials` (and the corresponding `conversation.gate_denials`) metrics.

## What this ADR does not change: ADR-0005's seam survives

This is the load-bearing nuance. ADR-0005's open-format store-write seam is not reversed. The seam, the documented contract that lets a producer append across a boundary without importing Feedback's internals, remains available for any future producer. What is removed is only Enforcement's particular use of it, the `gate.denial` producer. A future need (the re-addable count above, or some entirely different deterministic signal) can write across the same seam without re-deciding anything here. This ADR kills one producer, not the production interface.

## Considered options

- **Keep the emit seam.** Rejected once the no-footprint premise was falsified. With the denial already captured in the transcript and projected to a judge-visible chunk by Feedback's readers, the emit seam writes a redundant second copy of information the store can already reach through the canonical record, which is the duplication ADR-0005 was built to avoid.
- **Keep the emit seam solely to preserve the deterministic firing count.** Rejected as not worth its keep today. The count's only consumers are an evidence field nothing currently reads for live decisions and an OTLP metric whose dashboard is not running, so the count is paying maintenance cost (a hook script, a store table, three packages' worth of producers) for an output no one observes. Re-adding the seam later, scoped to a real count need, costs only forward-looking history, which the user accepted.
- **Reverse ADR-0005's store-write seam along with the producer.** Rejected and explicitly out of scope. The seam is a general production interface; removing it because its first producer left would foreclose future producers for no benefit. Only Enforcement's use of the seam is removed.
- **Have the judge depend on emitted denial events rather than the transcript.** Rejected because it is the inverse of ADR-0005's settled architecture: conversation content, including the `is_error` denial result, lives in the harness transcript and is read on demand at judge time, not duplicated into the store. The denial is already on that read path, so the judge needs nothing emitted.
