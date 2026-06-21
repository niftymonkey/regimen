# The v1 event contract

Every line in the Feedback append-only buffer is one v1 event: a normalized, harness-agnostic record of one thing that happened in an agent conversation. This is the semantic convention the whole system turns on. Capture hooks produce it (via the loader's translators), external producers write it directly (see `store-write-contract.md`), the store indexes it, and the evidence and judge layers read it.

The machine-checkable source of truth is `packages/feedback/schemas/event.schema.json` (JSON Schema 2020-12). This document is the prose companion: what each field means and why the vocabulary is shaped the way it is. If the two ever disagree, the schema wins and this document is the bug.

## Shape

A v1 event is a JSON object with these required fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | `1` | Versioned marker so readers can evolve the shape without ambiguity. |
| `timestamp` | RFC 3339 string (UTC) | When the event occurred; the span-boundary time when paired into a span. |
| `session_id` | non-empty string | Harness-native session id. Groups events into one trace. Stable across compactions for one harness session. |
| `harness` | enum | The agent CLI that fired it, normalized lowercase. Listing a harness here makes it a valid value of the convention; it does not assert a capture adapter exists. Current set: `claude`, `codex`, `gemini`, `cursor`, `opencode`, `copilot`. |
| `event_type` | enum | The normalized event name (see below). |
| `trace_id` | 32 lowercase hex chars | OTLP-native trace id derived from `session_id`; every event of a session shares it. The only id the capture hook assigns. |
| `span_phase` | `start` \| `end` \| `point` | Whether the event opens a span, closes one, or is instantaneous. Determined by `event_type`, carried explicitly as the harness-agnostic span marker. |
| `span_name` | non-empty string | Human-readable span label, e.g. `session`, `user_prompt`, `tool:Edit`. A tool's `tool.pre` and `tool.post` share it. |
| `attributes` | object | Event-specific key/value detail (see per-type table). |

Optional fields: `model` (the model that ran the turn, recorded per event not per session because routers resolve a different model per turn) and `cwd` (the working directory the harness reported, projected onto the conversations rollup, never stored per-event-row). Both follow "honest over tidy": a harness that does not expose them leaves them absent rather than fabricating a value.

## Event vocabulary and span phase

`event_type` is a closed, harness-agnostic enum, and the schema pins each type's `span_phase`:

| `event_type` | `span_phase` | Required attributes |
| --- | --- | --- |
| `session.start` | `start` | (none) |
| `session.end` | `end` | `end_reason_normalized` (always); `end_reason_native` when the harness exposes one |
| `user_prompt` | `point` | (none) |
| `agent.message` | `point` | (none) |
| `tool.pre` | `start` | `tool_name`, `tool_call_id` |
| `tool.post` | `end` | `tool_name`, `tool_call_id` |
| `compaction` | `point` | (none) |
| `gate.denial` | `point` | `gate_id`, `tool_name`, `tool_call_id` (and optional `reason`) |

A tool's `tool.pre` and `tool.post` carry the same `tool_name`, `tool_call_id`, and `span_name`, so readers pair them into one span. A skill invocation additionally carries `skill_name` (the skill slug, e.g. `tdd`) on the tool event, read from the harness's skill-tool input field; this is how skill usage stays one harness-agnostic attribute regardless of how each harness names its skill tool.

## trace_id derivation

`trace_id` is the lowercase hex of `sha256("trace:" + session_id)`, truncated to the first 32 characters (16 bytes, the OTLP trace-id width). It is deterministic from `session_id` alone, so any producer (the capture hook, the rollout tailer, or an external producer over the store-write contract) derives the identical trace id for the same session and their events group under one trace. The shared implementation is `traceIdFor` in `@regimen/shared`.

## session.end reasons

`session.end` always carries `end_reason_normalized`, drawn from a deliberately minimal vocabulary: `user_exit` (a clean, deliberate operator exit), `cleared` (a reset in place), and `other` (the explicit catch-all for an unrecognized or absent native reason). When the harness exposes its own end reason it is preserved verbatim in `end_reason_native` (e.g. Claude's `prompt_input_exit`); a harness that exposes none (e.g. Codex, whose `session.end` comes from the rollout tailer) omits it. The normalized vocabulary extends additively as new harness adapters land.

## Evolution

`schema_version` is `1`. The vocabulary grows additively: a new `event_type`, a new attribute, or a new `end_reason_normalized` value is added without bumping the version, and an older event that simply lacks a later-added field stays valid. A breaking change to an existing field's meaning or type is what would bump the version. Translators and readers are the only places that mint events; both emit through the per-harness event builders (`packages/feedback/src/loader/translators/<harness>-events.ts`) so the real-time hook path and the judge-time reader cannot drift on event_type, span phase, span name, harness stamp, or trace-id derivation.
