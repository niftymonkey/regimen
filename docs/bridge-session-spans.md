# Session spans: decided architecture, pending application

> **Status:** decided, not yet applied. Captured here so a topic detour loses nothing.
> **Applies to two canonical docs:** Part A edits `regimen/docs/observability-surfacing.md`; Part B edits `regimen-otlp-bridge/docs/architecture/bridge-daemon.md` (the "The open decision" section, which this resolves).
> Once both canonical docs are updated and the implementation plan is written, this file can be deleted.

## How we got here

The daemon design left one open decision: when does an open session become a trace, since Regimen sessions routinely never end cleanly. The first framing was a staleness window, emit the session span after the session group sits idle for some minutes. That framing was rejected. The reasoning that replaced it:

1. **An OTLP span's `end` is write-once.** There is no "open span" on the wire; a span message requires both `start` and `end`, so a span is transmitted only once, as a completed unit. Emitting a session span early therefore freezes a duration we cannot later correct. Emitting early means emitting wrong.
2. **A wrong duration is the expensive kind of wrong.** `observability-surfacing.md` makes session duration a comparative baseline column ("this session vs your median"). A session force-closed at an arbitrary idle boundary reports a false duration and corrupts the baseline every later session is judged against. That destroys signal, the one thing the layer exists to protect.
3. **The consumer reflects in retrospect, not live.** Both the daily loop and the long arc are backward-looking. There is no user need for a real-time session trace, so trace latency is cheap and correctness is not.
4. **Children are visible without the root.** A trace in Tempo is just spans sharing a `trace_id`, ingested independently. Tool and point spans export the moment they complete and are visible immediately. The root is not a gate. A never-ended session is a trace with all its children present and the root simply absent. That is an accurate artifact, not a degraded one: the absence of the root *means* the session has not ended.
5. **A long-open session is itself signal.** A session left open for a week with a little work each day is a real, valid use. Force-closing it at any boundary would both fabricate a duration and erase the staleness signal. We should not close it.

## Part A: additions to `observability-surfacing.md`

### A1. Session lifecycle states, and staleness as a first-class signal

The doc currently frames never-closed sessions as a degenerate case to "handle gracefully." Reframe: a session that is not progressing is a *true state a practitioner needs surfaced*.

- Name session lifecycle states: **ended** (clean `session.end`), **active** (recent events), **stalling** (open, but last activity is old relative to the practitioner's norm), **abandoned** (open, no activity for a long stretch).
- These states are derived from session age and last-activity, computed in the **metrics / session-list layer**, not from the trace.
- Treat **stalling** as first-class in the session list. "You have had one session open on review-kit for a week, with work on only 5 of 7 days" is exactly the actionable, comparative, session-first feedback the doc demands of every other signal. It belongs in the list as an age / last-activity column or a state badge.
- Explicit: the staleness signal lives in the list, never in the trace. The trace stays honestly open; the list does the surfacing.

This also touches the capture table row "Session duration and clean close ... never-closed is the common case": never-closed is not only common, it is sometimes the *interesting* case.

### A2. The representation must not lie to look tidy

A general design principle worth recording for future work, not just this decision. We were one step from force-closing spans so traces would look neat. That fabricates data. The principle:

> Prefer an honestly-incomplete representation (a rootless trace, an open session) over a tidy false one (a force-closed span with an invented end). When a signal is genuinely absent or unfinished, the surface should show that, not paper over it.

## Part B: bridge architecture changes (`bridge-daemon.md`)

These resolve and replace the "The open decision" section.

### B1. The root session span is never force-closed

- The root span for a `session_id` is emitted only on a real `session.end` event.
- A session that never ends has a permanently rootless trace: all children present and correct, root absent. This is correct and intended.
- There is no staleness window, no idle timer, no force-close. Drop that mechanism entirely.

### B2. Day-segment child spans

- Introduce one child span per calendar day a session had activity: the **day segment**. It is a child of the root and the parent of that day's tool and point spans.
- A day segment is the unit that *closes correctly and streams* even while the root stays open indefinitely. It gives a long-running session a clean per-day timeline and a correct per-day duration without ever lying about the root.
- "Day" is the daily log rotation period, which is Regimen's own capture behavior, harness-agnostic. If the rotation period changes, the segment unit changes with it.
- A day segment's `end` is the timestamp of the last real event of that session on that day.

### B3. The rotation-boundary flush retargets from root to day segment

- The earlier rotation-boundary flush logic is kept, not discarded. It now closes **day segments**, not sessions.
- Rule: when the first event dated day D+1 is consumed, close every open day segment whose day is D or earlier. A daily segment file is fully read before the next one, so seeing a D+1 event proves no more D events are coming.
- This stays pure event-timestamp logic, no wall clock, so the projection module remains pure and marble-testable. The root span is simply exempt from this flush.

### B4. Span `end` timestamps always come from real events

- Every span's `end` is the timestamp of a real event (the closing event of a pair, or the last observed event of a group), never the wall-clock moment the daemon decided to emit.
- This holds for tool spans, day segments, and the root.

### B5. Durability amendment: persist the open-session aggregation state

- The daemon's offset advances only past events whose signals were all delivered. `session.start` contributes a log and a metric tick (delivered immediately) and the root span (not delivered until `session.end`). So a never-ending session would pin the read offset at its `session.start` forever, forcing the daemon to re-derive from that point on every restart.
- Fix: persist a small **open-session state** sidecar: per open `session_id`, the accumulated bounds, the currently-open day segment, and any counters needed to resume. The offset can then advance past `session.start`, because the pending-span obligation is captured in the sidecar instead of implied by an un-passed offset.
- On restart the daemon rehydrates open sessions from the sidecar and resumes from the offset.
- This is a refinement of "durability is the event log plus a persisted read offset," adding "plus a small persisted open-session map." It is not a separate durable queue.
- Related: span-id minting must be deterministic from event identity, so any re-derivation after a crash is idempotent (no duplicate spans).

### B6. Rootless traces are accurate; note the Grafana caveat

- A rootless trace is the correct representation of an unfinished session and should not be treated as a defect.
- Known caveat: Grafana's trace *discovery* (search and trace lists keyed on root span name and duration) renders a rootless trace awkwardly. Trace *rendering* and span-level TraceQL queries are unaffected. Session-level discovery should lean on metrics and the session list, which is where it belongs anyway.

## Open follow-ups

- **Single-day sessions and day segments.** Whether a clean same-day session also gets a day-segment child (uniform, simpler) or day segments appear only once a session crosses a rotation (tidier, fewer near-duplicate spans). Minor; decide when writing the implementation plan.
- **Apply Part A** to `observability-surfacing.md`.
- **Apply Part B** to `bridge-daemon.md`, replacing "The open decision" and amending "Durability."
- **Then** write the tracer-bullet implementation plan for the daemon from the updated design doc.
