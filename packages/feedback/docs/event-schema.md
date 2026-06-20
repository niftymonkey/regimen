# Event schema

The capture hook appends each session event to a JSONL buffer at the capture edge. The loader drains the buffer into the SQLite store, normalizing every event to a single schema as it goes. This document explains that schema, the contract every event satisfies after normalization.

The authoritative contract is [`schemas/event.schema.json`](../schemas/event.schema.json): a JSON Schema (Draft 2020-12) that field names, types, and constraints are validated against. This document does not restate types. It explains why the contract looks the way it does.

## The event record

One event is one JSON object, one line of the append-only JSONL buffer. Fields, by intent:

| Field            | Intent                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version` | Versioned semantic-convention marker, the integer `1`.                                                                                      |
| `timestamp`      | When the event occurred. Event time for the log; the span boundary time when paired into a span.                                            |
| `session_id`     | The harness's own session id. Groups events into one trace. Stable across compactions.                                                      |
| `harness`        | Which agent harness fired the event. One of the six normalized identifiers.                                                                 |
| `model`          | The model that ran this event's turn. Per event, optional. See "Model is a per-event attribute".                                            |
| `cwd`            | The working directory the session ran in. Transport only, projected to the conversation. See "Working directory is a session-level anchor". |
| `event_type`     | Normalized, harness-agnostic event name. One of the eight types below.                                                                      |
| `trace_id`       | OTLP-native trace id, derived from `session_id`. The only id the capture hook assigns.                                                      |
| `span_phase`     | `start`, `end`, or `point`. The span-boundary marker.                                                                                       |
| `span_name`      | Human label for the span. Both events of a paired span carry the same name.                                                                 |
| `attributes`     | Open object of event-specific detail. `tool.pre` and `tool.post` carry `tool_name` and `tool_call_id`.                                      |

### The eight event types

| `event_type`    | `span_phase` | What it marks                                                                                                                                                                       |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start` | `start`      | Opens the root session span.                                                                                                                                                        |
| `session.end`   | `end`        | Closes the root session span.                                                                                                                                                       |
| `user_prompt`   | `point`      | An operator prompt, instantaneous. Carries an optional per-session `seq` on the rollout path.                                                                                       |
| `agent.message` | `point`      | The agent's visible message to the operator, instantaneous. Gives assistant text a stable anchor for the judgment layer. Carries an optional per-session `seq` on the rollout path. |
| `tool.pre`      | `start`      | Opens a tool-call span. Carries `tool_name`, `tool_call_id`.                                                                                                                        |
| `tool.post`     | `end`        | Closes a tool-call span. Carries `tool_name`, `tool_call_id`.                                                                                                                       |
| `compaction`    | `point`      | Marks a context compaction. See "Compaction is one normalized event".                                                                                                               |
| `gate.denial`   | `point`      | Marks a discipline gate denying a tool call. See "Gate denials".                                                                                                                    |

Each event name is normalized and harness-agnostic: a producer maps a harness's native signal to one of these names at capture time, rather than later in the pipeline, which keeps the JSONL buffer harness-agnostic and makes the schema a cross-harness semantic convention.

## What the capture path retains and drops

The capture hook appends the full raw harness payload inside each envelope, so nothing is lost before translation. The translator then narrows that payload to the small, harness-agnostic `attributes` set the schema models. This is deliberate: the schema is a cross-harness semantic convention, not a transcript, so a property is retained only when a Feedback need justifies it, never indiscriminately. A dropped property cannot be recovered later, because the raw payload is not kept past translation, so the retained set is the contract for what Feedback can ever answer.

The table below is the audit of what each hook event carries versus what the translator keeps, across the supported harnesses. "Base" is the always-present `session_id`, `model` (when the payload exposes one), and the `captured_at` timestamp.

| Hook event         | Carried beyond base                                                                                                                                                     | Retained in `attributes`                                                             | Dropped, and why                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`     | `source`, `cwd`, `transcript_path`, `permission_mode`                                                                                                                   | `cwd` (as the top-level field, not an attribute)                                     | `cwd` is retained as the conversation's working-directory anchor; `source` (startup/resume/compact) is low marginal signal for the tight loop; `transcript_path` and `permission_mode` are environment, not behaviour. |
| `UserPromptSubmit` | `prompt`, `turn_id` (Codex)                                                                                                                                             | nothing                                                                              | The full prompt text is high volume and carries operator content verbatim; it is not a structured signal, so it is left in the raw transcript, not the store.                                                          |
| `PreToolUse`       | `tool_name`, `tool_input`, `tool_use_id`; `tool_input.skill` (Skill tool); `tool_input.file_path` (Claude edits); `tool_input.command`; `agent_type` (Claude subagents) | `tool_name`, `tool_call_id`, `file_path` (when present), `skill_name` (when present) | Command text is high volume and can carry secrets; subagent attribution is a real but Claude-only signal deferred to its own ticket.                                                                                   |
| `PostToolUse`      | all `PreToolUse` fields + `tool_response`, `duration_ms` (Claude)                                                                                                       | same as `PreToolUse`                                                                 | Tool outcome (exit code / status) is high value but needs a cross-tool, cross-harness normalization design, so it is deferred to its own ticket; `duration_ms` is already derived from the span's paired timestamps.   |
| `PreCompact`       | `trigger`                                                                                                                                                               | `trigger`                                                                            | The trigger (manual/auto) is the one property that distinguishes a forced from an automatic compaction, so it is retained.                                                                                             |
| `SessionEnd`       | `reason` (Claude)                                                                                                                                                       | `end_reason_native` (verbatim), `end_reason_normalized` (always)                     | Nothing else: a clean exit versus an abrupt or abandoned one is exactly the distinction the tight loop needs, so the reason is the one property kept. See "Session-end reason".                                        |

Codex's rollout transcript reader, the version-proof fallback, retains the same `attributes` from the rollout's own fields (a tool call's serialized `arguments`/`input`), so the hook path and the rollout path stay consistent: a skill invocation surfaces `skill_name` whether it was captured live from a hook or recovered from a rollout.

### Skill identity

When the agent invokes a skill, the harness records it as a `Skill` tool call whose input names the skill (`tool_input.skill`, for example `tdd`). Keeping only `tool_name` would record that _a_ skill ran but not _which_, leaving the evidence layer skill-blind: it could not say which skills earn their keep or which guidance is being ignored, exactly the signal the tight loop and the judgment layer need. So the translator retains the skill slug as the `skill_name` attribute on the tool call. It is harness-agnostic by construction: every producer (the Claude hook translator, the Codex hook translator, the Codex rollout reader) reads the skill from the same input field through one shared reader, so the paths cannot drift. Downstream, the `skill_invocations` signal table rolls up invocations per skill per conversation, and the evidence digest surfaces them as `skillUsage`.

### Session-end reason

A `session.end` event records two additive attributes alongside the boundary: `end_reason_native`, the harness-native end reason preserved verbatim, and `end_reason_normalized`, a value drawn from a small harness-agnostic vocabulary. Without them a clean finish, an abandonment, and a crash all look identical in the store, which is exactly the distinction the tight loop and the later judgment layer need. The native value is kept verbatim because it is the harness's own word for what happened and cannot be reconstructed once dropped; the normalized value is what a cross-harness reader queries.

The normalized vocabulary is the minimal set the implemented harnesses produce, with a mandatory catch-all. It extends additively as new harness adapters land (the cross-harness portability studies are the prior art for that extension):

| `end_reason_normalized` | Meaning                                      | Reader's read |
| ----------------------- | -------------------------------------------- | ------------- |
| `user_exit`             | The operator deliberately ended the session. | clean         |
| `cleared`               | The session was reset or cleared in place.   | clean (reset) |
| `other`                 | The explicit catch-all.                      | unknown       |

`other` is mandatory and load-bearing: an unrecognized native reason, or none at all, normalizes to `other` rather than failing translation or quarantining the event. So the field is always present on a `session.end`, never absent, and never the cause of a dropped event.

Per harness, the native surface this normalizes from:

| Harness  | Native session-end surface           | Native values                                        | Normalizes to                                |
| -------- | ------------------------------------ | ---------------------------------------------------- | -------------------------------------------- |
| Claude   | `SessionEnd.reason`                  | `prompt_input_exit`, `logout`, `clear`, `other`      | `user_exit`, `user_exit`, `cleared`, `other` |
| Codex    | none (no `SessionEnd` hook)          | none; the rollout tailer closes the span             | `other`                                      |
| Copilot  | `sessionEnd.reason`                  | `user_exit`, `complete`, `error`, `timeout`, `abort` | not yet mapped (no adapter)                  |
| Gemini   | `SessionEnd.reason` (advisory)       | exposes a `reason` field                             | not yet mapped (no adapter)                  |
| Cursor   | `sessionEnd` (fire-and-forget)       | no documented payload fields                         | `other`                                      |
| OpenCode | `session.deleted` (observation only) | no reason surface                                    | `other`                                      |

Only the Claude and Codex translators are implemented today, and the vocabulary is the minimal set they produce: `user_exit`, `cleared`, `other`. The table's other harnesses have no capture adapter yet; their native surfaces are recorded here as prior art. When such an adapter lands, a richer native set (for example Copilot's `complete`/`error`/`timeout`/`abort`) extends the vocabulary additively rather than overloading `other`, since adding an enum value is an additive, non-destructive schema change. Each harness's native-to-normalized mapping is a pure function at the harness edge (`src/loader/translators/end-reason.ts`), the only place harness-specific knowledge is allowed.

Downstream, the deterministic projection that closes the session span records both values on the conversation's row (`session_end_reason_native`, `session_end_reason_normalized` on `conversations`), so a reader sees how a session ended without re-deriving it from raw events. The change is additive to schema v1: a `session.end` from before these attributes existed simply lacks them and remains valid, and the store migration adds nullable columns without rewriting existing rows.

## Model is a per-event attribute

The architecture makes the model a first-class attribute, distinct from the harness, so a single model can be evaluated on its own terms. The schema records it on `model`, a top-level field parallel to `harness`, not inside the open `attributes` bag: a first-class attribute belongs at the top level next to the other first-class one.

It is recorded **per event, not per session**. Harnesses with a model router (Cursor's `Auto`, Gemini's `Auto`) resolve a different underlying model from one turn to the next, and every harness studied lets the operator switch models mid-session. A session-level model attribute would therefore be wrong for any session whose model changed, and the studies confirm that is a normal case, not an edge case. Recording per event also subsumes per-turn granularity, so the schema needs no separate turn concept.

Two consequences shape the field:

- **It records the resolved model, never the router label.** When a harness routes via `Auto`, `model` is the model that actually ran the turn (for example `gpt-5.2`), which the harness exposes in its hook input. The string `Auto` is never a value of `model`.
- **It is optional.** A harness may not expose the model on every hook event, and before the first turn of a session no model has been resolved at all. A `session.start` event legitimately carries no `model`. Consumers treat an absent `model` as unknown, not as a default.

`model` is a single normalized identifier. Modern model ids already encode their version (`claude-opus-4-7`, `gpt-5.2`), so the schema does not split a separate `model_version` field. If a real need to separate a bare family from a dated snapshot emerges, splitting the string later is a cheap, additive change.

## Working directory is a session-level anchor

`cwd` is the directory the harness session ran in. Without it, a practitioner who moves between repositories over a stretch of work cannot tell, from the Feedback data, which conversation belongs to which body of work: every conversation is structurally identical apart from its session id. The working directory is the most basic answer to _what a conversation was about_, and it is the groundwork for rolling work up by project in the long arc.

It is the mirror image of `model`. Where `model` is recorded **per event** because the active model genuinely changes from turn to turn, `cwd` is a **session-level** fact: where the session opened. So although it rides on the event as a top-level field (parallel to `model`, never buried in the open `attributes` bag), the loader projects it onto the `conversations` rollup rather than storing it on every event row, and pins it **first-wins**, the earliest event that carried one. That anchors a conversation to where it started rather than drifting if the agent later changed directories.

It is **harness-agnostic and optional.** Claude and Codex both expose the directory on their hook payloads (`cwd`), and the Codex rollout transcript carries it in `session_meta`, so every producer feeds the same field through one path. A harness that exposes no directory, or a conversation that predates this capture, leaves `cwd` absent on the event and `null` on the conversation, never a fabricated or default path ("Honest over tidy").

## Compaction is one normalized event

Context compaction is the moment a harness compresses its context to stay within the model's window. The portability studies found the native signal varies sharply across harnesses: some fire a pre- and a post-compaction event, some only a pre-compaction signal, and the mechanism ranges from a first-class hook to an experimental plugin seam.

The schema normalizes all of that into **one `compaction` event per compaction**, regardless of how many native signals the harness fired. The capture adapter anchors the event on the harness's **pre-compaction signal**, the one signal every observing harness has, so the event consistently marks the moment compaction began. Where a harness also emits a post-compaction signal, the schema does not record it separately: a pre/post pair would model compaction as a span with a duration, and compaction is used as a timeline marker, not as a unit of work. So `compaction` is a `point`, like `user_prompt`.

Modeling it as a single point event is what makes the compaction count comparable across harnesses: one event per compaction means the count is the number of compactions, whatever the underlying harness mechanism.

### Per-harness compaction availability

A compaction count of 0 is ambiguous on its own: it can mean the session had no compactions, or that the harness cannot observe them. The architecture resolves that with an explicit per-harness availability flag. The schema records that flag as a **static capability matrix in this convention**, not in the event stream. Compaction observability is a fixed property of a harness, not session-varying data, so it belongs in the versioned convention, updated in one place when a harness changes, rather than re-emitted on every session by each capture adapter. Downstream readers resolve availability from the `schema_version` and `harness` the log already carries.

| Harness    | Native compaction signal                                               | `compaction` observability |
| ---------- | ---------------------------------------------------------------------- | -------------------------- |
| `claude`   | `PreCompact` + `PostCompact` hooks                                     | observed                   |
| `codex`    | `PreCompact` + `PostCompact` hooks                                     | observed                   |
| `cursor`   | `preCompact` hook (pre only; observational, cannot block)              | observed                   |
| `gemini`   | `PreCompress` hook (pre only; advisory)                                | observed                   |
| `copilot`  | `preCompact` hook (pre only; advisory)                                 | observed                   |
| `opencode` | `experimental.session.compacting` + `session.compacted` (experimental) | observed                   |

Every harness covered by the portability studies (verified 2026-05-14) observes compaction. The `unobserved` state still exists in the vocabulary: it is the correct reading for any harness outside these studies and the default a downstream reader assumes when the matrix has no entry for a harness. The matrix is keyed by harness only; a harness adding or removing a compaction hook in a later release is a per-harness-version concern.

## Gate denials

A deterministic discipline gate is a hook that denies a tool call violating a rule: blocking a destructive command, an edit to a protected path, a banned character. A gate firing is the deliberate-practice loop made visible. The schema records each firing as a `gate.denial` event.

### Why the denying gate emits the event

A gate denial cannot be captured by observing it after the fact. On Claude, a discipline gate is a `PreToolUse` hook returning `permissionDecision: "deny"`; when it does, no later hook event fires, and the capture hook, itself a `PreToolUse` hook, cannot see another hook's decision. `PermissionDenied` exists but fires only for the auto-mode permission classifier, not for a discipline gate. Every other studied harness has the same shape: the gate is the only component that knows it denied.

So the gate that denies emits the `gate.denial` event itself. This is harness-agnostic (every studied harness's gate is a hook that runs code and can therefore append to the buffer) and robust to hook ordering (the event does not depend on whether the capture hook ran). It is the one mechanism that works.

### The contract is the event, not a tool

The contract is the schema: a `gate.denial` is a JSONL line conforming to it, carrying `gate_id` (a free-form identifier the gate chooses for itself, with no enum of known gates), the denied `tool_name` and `tool_call_id`, and an optional `reason`. Any gate, on any harness, in any language, that appends such a line has its denial recorded. There is no registry of approved gates and nothing gate-specific in the schema.

This section is the event-content contract. Where to append the line and how an out-of-process producer targets the seam (the buffer location, the no-`payload` dispatch rule, the frozen `trace_id` derivation, and append and idempotency semantics) is the [store-write contract](./store-write-contract.md).

The gates and the denial emitter are external producers: they live in the separate enforcement package and write `gate.denial` events across that store-write contract. Feedback owns the event-content contract here and the seam there, and reads the resulting events from the store; it does not ship the emitter or the reference gates. A gate in any language that appends a conforming line has its denial recorded, with no registry of approved gates and nothing gate-specific in the schema.

### Per-harness denial capture

The mechanism is uniform, because every studied harness exposes a pre-tool gate that runs custom code:

| Harness    | Gate that can deny a tool call                      |
| ---------- | --------------------------------------------------- |
| `claude`   | `PreToolUse` hook (`permissionDecision: deny`)      |
| `codex`    | `PreToolUse` hook (`permissionDecision: deny`)      |
| `gemini`   | `BeforeTool` hook (`decision: deny`)                |
| `cursor`   | `preToolUse` hook (`permission: deny`)              |
| `copilot`  | `preToolUse` hook (`permissionDecision: deny`)      |
| `opencode` | `tool.execute.before` plugin hook (throws to block) |

No studied harness has a usable separate "a denial happened" event the capture hook could subscribe to, so none is relied on. The denying gate emitting its own event is the single mechanism on all six.

### Correlation with the denied call

A `gate.denial` carries the denied call's `tool_call_id`, so downstream readers correlate it with that call's `tool.pre`. This sharpens what an unpaired `tool.pre` means: one with a matching `gate.denial` is a call a gate denied, attributable to which gate and why; one with no match was interrupted or denied by hand. A `gate.denial` is self-sufficient even with no `tool.pre` at all (when the gate ran before the capture hook observed the call), because it already names the tool, the call, and the gate.

## Ids: the hook assigns one, the rest are minted later

The capture hook fires once per event and exits; it cannot pair a `tool.pre` with its later `tool.post`, so it assigns exactly one id: `trace_id`.

- **`trace_id`** is derived by hashing `session_id` to OTLP-native width (32 hex chars). Every event of a session carries the same `trace_id`. A log record needs it to link to its trace.
- **Span ids are not in the event.** They are minted by downstream readers at the moment they need to construct spans (for example, the OTLP bridge when it builds OTLP trace output).

## The span model

The JSONL buffer is flat: a stream of point-in-time events. A trace is a span tree. Downstream readers reconstruct the tree when they need spans:

- **A trace** is every event sharing a `trace_id` (equivalently, one `session_id`).
- **The session span** is the root, recognized from the `session.start` and `session.end` events.
- **A tool span** is a `tool.pre` paired with the `tool.post` carrying the same `attributes.tool_call_id`.
- **A `user_prompt`** is a zero-duration span (a point).
- **A `compaction`** is a zero-duration span (a point), a marker on the session timeline. It nests directly under the session span, like a `user_prompt`. It is never paired into a duration.
- **A `gate.denial`** is a zero-duration span (a point) nested under the session span. It carries the denied call's `tool_call_id`, correlating it with that call's `tool.pre`.
- **An unpaired `tool.pre`** (no `tool.post`) is a tool call that did not complete. A matching `gate.denial` identifies it as a gate denial, which a reader renders as such; with no match it was interrupted or denied by hand.

## The sample

[`samples/event.jsonl`](../samples/event.jsonl) is an eleven-event Cursor session: `session.start` (no model resolved yet), a turn on `gpt-5.2`, a `compaction`, then a second turn the `Auto` router resolved to `sonnet-4.5-thinking`, in which a `Bash` call is denied by a discipline gate. It exercises every part of the schema: the harness enum, `model` recorded per event with a mid-session change, `model` absent where no model is resolved, the `compaction` point event, and a `gate.denial` correlated by `tool_call_id` with the `tool.pre` of the denied call. It is an illustrative hand-written fixture, not capture output; it validates against the schema.

## Versioning

The schema is versioned by a single integer in the `schema_version` field, currently `1`. The schema's filename is unversioned: there is only one schema at a time, and the version lives inside the schema's content. Consumers read `schema_version` on each event to decide what parser to use.

- **Additive changes** (new optional fields, new event types with safe defaults, new enum values) keep `schema_version` at its current value. Old readers tolerate additive changes because new fields are optional and unknown enum values can be handled defensively.
- **Breaking changes** (field removals, type changes, semantics changes) bump `schema_version` by one. The loader inspects each event's `schema_version` and dispatches to a version-appropriate parser. The SQLite `events` table carries `schema_version` per row, so mixed-version data is handled deterministically; a schema bump may also require a SQLite migration of the rows, written as code in this repo and run once.
- **Integer, not semver.** The only thing a reader does with `schema_version` is decide whether to parse the event, a single comparable check. Patch and minor segments do not have meaningful semantics for an event-schema wire format: additive changes do not break readers (no minor bump needed), and there is no "bugfix" to a schema (no patch bump). A single integer is what readers actually need.
- **Old versions are supported as long as data carrying them exists** in either the buffer or the SQLite store. Once all storage is at version N, version N-1 parsers can be dropped.

## Earlier approaches considered

These were tried and superseded by the current design. Recorded so a later reader does not re-propose them.

- **A versioned line of schemas (v0 then v1).** An earlier tracer-bullet phase introduced a minimal v0 schema, then folded in `compaction`, `gate.denial`, a widened harness enum, and per-event `model` to reach v1. With the design settled in ADR-0005, the version distinction added nothing for a fresh reader. The schema is now the schema; `schema_version` is retained as a single constant for future migration if the schema ever bumps, but the schema is no longer framed as "version N of an evolving line." Do not reintroduce parallel versioned schemas.
- **Read-time projection from JSONL into the three OTel signal shapes.** An earlier framing projected the JSONL log on read into OTel logs, metrics, and traces, computed by a surfacing layer that lived in this repo. ADR-0005 supersedes this: the loader writes normalized events to SQLite, deterministic signals are computed at write time into signal tables, and OTLP output (for downstream tools like Grafana) is the OTLP bridge's concern, reading from SQLite. The schema describes events; what readers do with them is downstream. Do not reintroduce a surfacing layer that projects the JSONL buffer.
