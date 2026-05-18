# Observability surfacing

> What the observability layer must communicate, and what that demands of the events we capture. Part of the Regimen program.

## Why this doc exists

In Phase 1 we built the tracer-bullet telemetry pipe and prototyped dashboards in Grafana against real captured data. The dashboards themselves are throwaway. Their purpose was to see what our data actually looks like once it lands, and to find what is missing for the observability layer to genuinely help.

The exercise surfaced a clear lesson, recorded here so that every event type, metric, and schema field designed from now on is designed eyes-open. We capture what we capture because we know what we need to surface.

The consumer of this layer is the practitioner, and increasingly an AI agent reading the telemetry on their behalf. Both need the same thing: signal, not raw activity.

## The lesson: activity is not feedback

The prototype dashboard showed activity. Counts, rates, a tool-mix breakdown, "927 events", "47% Bash". All true, and close to useless for improving a practice. A practitioner cannot act on an aggregate count.

Deliberate practice needs feedback a person can act on. The gap between "here is what happened" and "here is how it went, and what to change" is the entire job of this layer. Two failures produced the gap:

1. **Aggregate-first instead of session-first.** The unit a practitioner reflects on is a single session. Aggregates are context, not the object.
2. **Numbers without baselines.** "34 prompts" means nothing until it sits beside "your median is 5". A number becomes a signal only in comparison.

## What the layer must let a practitioner do

The observability layer exists so a practitioner can answer, after a stretch of work:

- Which of my sessions went badly, so I know what to reflect on.
- What "badly" looked like, where the friction was: high steering, tool thrash, long stalls, drift, abandoned work.
- In a bad session, where it went wrong: the timeline.
- Across weeks, whether it is improving: the trend, which needs history.

The first three are the daily loop. The fourth is the long arc. The layer serves the loop first.

## Principles

1. **Session-first.** The session is the primary object. A session list, sorted so rough sessions surface, is the home view. Aggregates shrink to a context strip.
2. **Comparative.** Every surfaced number carries a baseline: this session against your median, this week against last.
3. **Quality over volume.** Surface which sessions went badly, not how much happened.
4. **Actionable.** Each surfaced signal maps to a reflection or a lever the practitioner can pull. A signal that implies no action is noise.
5. **A home for judgment from day one.** The signals that need AI judgment, correction rate and drift and outcome, carry labelled placeholders even before Tier 2 exists, so the shape of the full picture is always visible.

## What this demands of what we capture

This is the eyes-open part. When designing events and metrics, work backward from the surface:

| To surface | What we must capture | Status |
| --- | --- | --- |
| Session duration and clean close | `session.start` / `session.end`, plus graceful handling of never-closed sessions | v0 has it; never-closed is the common case |
| Steering load | `user_prompt` events | v0 has it |
| Tool thrash and tool mix | `tool.pre` / `tool.post` with tool name | v0 has it |
| Thinking vs doing | span timing across a session; the untraced gaps are model inference | v0 traces allow it; needs a derived per-session ratio |
| Per-model views | `model` as a per-event attribute | v1 schema |
| Compaction sprawl | a normalized compaction event | v1 schema |
| Discipline-gate denials | a denial event when a guardrail blocks the agent | `regimen-observability#5` |
| Correction rate, drift, session outcome | Tier 2 judged metrics | Tier 2, Phase 3 |
| The session list's at-a-glance columns | a counted-metric set chosen to feed exactly those columns | Phase 2 |

The counted-metric set (Phase 2) should not be chosen abstractly. It should be chosen as the columns of the session list: duration, tool calls, prompts, thinking-vs-doing split, compactions, denials. Metrics and surface are designed as one thing.

## Target dashboard shape

For whenever we return to the UI. Three surfaces:

- **Practice.** The session list with rough sessions surfaced, a small health strip, and recent-character panels (tool mix, session-length histogram). The triage view.
- **Session.** The drill-in: the event timeline, this session against your median, tool mix, thinking-vs-doing, your steering points. Reached by clicking a session in Practice.
- **Trends.** The long arc. Deferred until there are weeks of history; a short window only makes it look broken.

The session list is a table designed to gain columns. When v1 events and Tier 2 verdicts land it gains a model column, a compactions column, an outcome column. It is never rebuilt. That is the test of this design: new capability fills placeholders and adds columns, it does not force a redesign.

## What we are not doing

Not polishing the Grafana dashboards. The Phase 1 prototype did its job: it taught us the shape of the data and the shape of the need. The next return to a UI happens after the Phase 2 events exist, built against this doc.
