# Plan: Regimen

> Source PRD: [`../PRD.md`](../PRD.md). Phased implementation broken into vertical tracer-bullet slices, each demoable on its own.

## Architectural decisions

Durable across every phase. Sourced from the ADRs and PRD; restated here so each slice can reference them:

- **Multi-repo program.** One repo per instrument plus the bridge separate: `regimen` (hub), `regimen-feedback`, `regimen-enforcement`, `skills` (Guidance), `regimen-otlp-bridge`. Settled in ADR-0004.
- **Instruments cut by mechanism.** Guidance instructs, Enforcement compels, Feedback observes. Settled in ADR-0002.
- **Feedback measures the conversation, not the software.** Soundness enters only through engineer reactions captured as signals. Settled in ADR-0003.
- **Feedback's data architecture.** Capture hook appends raw envelopes (`{harness, captured_at, payload}`) to a JSONL buffer; the loader translates per-harness events to the canonical v1 schema and writes to a local SQLite store; conversation content stays in the harness's own transcript file, never duplicated. Settled in ADR-0005.
- **Loader is an opt-in always-on daemon.** Real-time freshness is the substrate. Per-harness translation is the only harness-specific seam. Capture and storage share one enabled-flag gate. First-class on Linux, macOS, native Windows. Idempotency by sha256 `event_hash` and `INSERT OR IGNORE`. Settled in ADR-0006.
- **SQLite schema (loader-owned tables).** `events` (one row per v1 event, all first-class fields as columns, `attributes` as JSON), `conversations` (per-session rollup), `tool_call_spans` (paired tool.pre/tool.post), `repeated_file_edits`, `gate_denials`, `quarantine`, `schema_migrations`. Settled in ADR-0006.
- **Judge LLM defaults to the engineer's already-configured agent LLM**, behind a configuration seam that allows swapping later. Decision in PRD's Implementation Decisions.
- **Guidance is skills generally; the curated `skills` repo is one good source**, not the canonical container. Other sources (CLI defaults, organization-curated sets, external collections) are valid.
- **Local-only by default, no telemetry to authors.** The LLM call during judgment is the only network egress.
- **Single-user in current scope.** Team-shared or aggregated use cases are future directions the architecture leaves room for, not commitments.
- **"Honest over tidy."** Incomplete data renders as incomplete: open conversations stay open, unpaired tool calls stay unpaired, missing model stays missing. The loader and judge never impute state. Settled in `feedback-surfacing.md`.

---

## Phase 1.1: End-to-end evidence pipe

**User stories**: 1, 2, 4, 5, 13, 19, 20, 21, 23, 24.

### What to build

The first tracer bullet, from capture to CLI. The Claude capture hook is rewritten to append only the envelope; the existing translation logic moves into a Claude translator in the loader's per-harness translator registry. A minimal daemon process watches the JSONL buffer, dispatches each line through the translator, hashes the v1 event, and inserts into the SQLite `events` table with `INSERT OR IGNORE`. The daemon runs in foreground for development; full lifecycle and install come later. A minimal CLI exposes `feedback list` (recent conversations grouped by `session_id`, basic columns only) and `feedback show <session_id>` (event timeline for one conversation). No load-time signal projections beyond what raw SQL queries can derive.

### Acceptance criteria

- [ ] A Claude Code session produces events that land in SQLite within roughly a second of being fired.
- [ ] The `events` table contains one row per event with every canonical field populated, including `event_hash`, `schema_version`, `trace_id`, `session_id`, `timestamp`, `harness`, `model` (where available), `event_type`, `span_phase`, `span_name`, and `attributes` as JSON text.
- [ ] `feedback list` shows recent conversations with at least session id, harness, model, first and last event timestamps.
- [ ] `feedback show <session_id>` shows the events of that session in timestamp order.
- [ ] Restarting the daemon against the same buffer does not produce duplicate rows (idempotency by `event_hash`).
- [ ] The harness's own transcript files are never modified.

---

## Phase 1.2: Load-time signal projections

**User stories**: 4, 5, 13.

### What to build

The signal projection engine runs alongside the event writer in the same transaction per event. Five tables are populated: `conversations` (rolled-up per-session state including counts and last-event timestamps), `tool_call_spans` (paired tool.pre and tool.post with nullable `ended_at` and `duration_ms` for unpaired calls), `repeated_file_edits` (per session, per file), `gate_denials` (one row per `gate.denial` event), and `quarantine` (lines that failed to translate). The CLI's list view now sorts conversations by worth-reflecting-on (recency plus simple heuristic) and shows anchors (counts, model, staleness state). The show view pairs tool calls into spans, surfaces gate firings inline with the events they apply to, and highlights repeated edits.

### Acceptance criteria

- [ ] The five signal tables populate as events stream in; deterministic upsert keys prevent duplicates on replay.
- [ ] An open conversation renders as open (`session_ended_at` is null); the loader never imputes a `session.end`.
- [ ] An unpaired `tool.pre` renders as in-progress (`ended_at` and `duration_ms` null), never force-closed.
- [ ] `feedback list` sorts conversations meaningfully so the ones worth reflecting on rise first.
- [ ] `feedback show` renders paired tool spans with durations, denials inline at the relevant event, and a heat indicator for repeated edits.

---

## Phase 1.3: Daemon lifecycle and cross-platform install

**User stories**: 12, 19, 24, 26.

### What to build

`feedback start`, `feedback stop`, `feedback status`, `feedback restart` lifecycle commands. `feedback install-daemon` writes an OS-appropriate service unit (launchd LaunchAgent plist on macOS, `systemd --user` unit on Linux, Task Scheduler entry on Windows) so the daemon survives logouts. The enabled-flag gate is implemented and respected by both the capture hook (stat per event) and the daemon (poll on a short cadence, self-exit when the flag is removed). `feedback purge` discards the buffer and, with a confirm flag, the SQLite store. `feedback status` exposes daemon health (running state, last event timestamp, lag, backlog) so a dead daemon is never silent staleness.

### Acceptance criteria

- [ ] `feedback install-daemon` installs the service unit cleanly on Linux, macOS, and native Windows.
- [ ] `feedback start` followed by `feedback stop` cleanly halts capture (subsequent hook invocations are no-ops) and shuts down the daemon.
- [ ] Toggling the enabled flag mid-session does not corrupt state or produce partial events.
- [ ] `feedback status` reports daemon state correctly and surfaces a clear message when the flag is on but the daemon is dead.
- [ ] `feedback purge` deletes only Regimen-owned state (buffer, SQLite); harness transcript files are untouched.

---

## Phase 1.4: In-session evidence skill

**User stories**: 6.

### What to build

A Guidance skill in the `skills` repo that the in-conversation agent can invoke to pull evidence-layer signals about its own current session. The skill calls the Feedback CLI with a structured-output mode, parses the response, and renders the relevant signals (tool counts, recent activity, current staleness state, repeated edits, gate firings) back into the agent's working context. No LLM call inside the skill itself; this is pure deterministic evidence-layer access.

### Acceptance criteria

- [ ] In a live Claude Code session, invoking the skill returns evidence-layer signals for the current session.
- [ ] The output is structured enough for the agent to act on (named signals, numeric or categorical values, no parsing ambiguity).
- [ ] The skill reads only from the local SQLite store; no network call is made.
- [ ] The skill returns useful output even on a session with very few events (graceful behavior when most counters are zero).

---

## Phase 1.5: Second harness (Codex)

**User stories**: 17, 18.

### What to build

Codex capture hook plus Codex translator. Demonstrates the per-harness-adapter pattern from ADR-0006: adding a harness is one new capture hook file plus one new translator in the loader's translator registry. The Codex hook follows the same envelope contract as Claude; the translator maps Codex's hook event names and payload shapes into canonical v1 events. The signal projections, CLI, and existing skills work unchanged when Codex sessions arrive in the buffer alongside Claude's.

### Acceptance criteria

- [ ] A Codex session produces events that land in SQLite with `harness: "codex"`.
- [ ] Events from concurrent Claude and Codex sessions interleave cleanly in the buffer and translate correctly.
- [ ] `feedback list` shows sessions from both harnesses without distinction in list shape.
- [ ] The in-session evidence skill works on Codex (with whatever Codex-specific adaptation is needed).
- [ ] The Codex denial event mechanism is documented and producing `gate.denial` events that flow into Feedback like Claude's.

---

## Phase 2.1: First `feedback assess` invocation

**User stories**: 7.

### What to build

`feedback assess <session_id>` performs one judgment pass over a single conversation. A per-harness transcript reader (Claude first, its schema settled in a sub-ADR) reads the harness's transcript file from disk. The CLI assembles structural events plus transcript content, calls the LLM with a versioned prompt and structured-output schema, parses the response, and writes one narrative row plus an initial set of judged signals (Intent and Outcome at minimum) into SQLite, each anchored to specific events. The judge LLM defaults to the engineer's already-configured agent LLM (config seam present for swapping later).

### Acceptance criteria

- [ ] `feedback assess <session_id>` produces a written assessment readable in the CLI.
- [ ] Every claim in the narrative anchors to one or more events in `events`, and the anchors round-trip (re-running render produces the same anchors).
- [ ] Intent and Outcome judged signals are written for the conversation and persisted.
- [ ] Re-running `feedback assess` for the same session does not duplicate signals; the most recent run's results supersede or version cleanly.
- [ ] If the transcript file is missing, the command exits with a clear error rather than producing a half-judged result.

---

## Phase 2.2: Assignment segmentation, intent, and outcome

**User stories**: 9.

### What to build

The judge segments a conversation into one or more assignments and classifies each with intent (refactor, bug-fix, feature, test-writing, exploration, schema-change, and so on) and outcome (accomplished cleanly, accomplished with correction, partial, abandoned). All other judgment-layer signals from `feedback-surfacing.md` (Correction rate, Correction types, Prompt clarity, Drift, Struggle, Expressed dissatisfaction, Silent acceptance) are emitted as part of the same pass, each anchored to events. The CLI's show command surfaces the per-assignment classification alongside the timeline.

### Acceptance criteria

- [ ] A conversation containing distinct work units is segmented into multiple assignments, each with intent and outcome.
- [ ] All judgment-layer signals from `feedback-surfacing.md` are emitted with anchors.
- [ ] `feedback show` displays per-assignment classification inline, with the events that anchor each signal visible nearby.
- [ ] Re-running the judge against the same session produces deterministic anchors for identical evidence.

---

## Phase 2.3: Cross-conversation rollups by intent

**User stories**: 3 (full comparative), 10.

### What to build

A CLI surface (`feedback trends` or an extension of `feedback list --by-intent`) aggregates assignments by intent across a window (last N conversations, last week, last month). Surfaces trends like "refactor outcomes over the last month" or "exploration assignments are getting cleaner over time." Comparative signals against an engineer's own past history are computed here, sharpening individual conversation signals once enough history exists.

### Acceptance criteria

- [ ] CLI shows rollups by intent over a window.
- [ ] Trends are queryable and sliceable by model and harness.
- [ ] An individual conversation's signals can be displayed against the engineer's own median for the same intent.
- [ ] All data feeding the rollups comes from judged signals already in SQLite (no recomputation per query).

---

## Phase 2.4: Respond-step pattern surfacing and suggestions

**User stories**: 11.

### What to build

Pattern detection over cross-conversation signals identifies recurring patterns of manual correction, steering, or drift. The CLI surfaces each pattern in plain language plus a concrete suggestion of what to research, build, or invoke (a Guidance skill, an Enforcement gate, a routing change). The narrative outputs from `feedback-surfacing.md` (assessment, what-helped, skill-gap, routing recommendations) are exposed through the CLI.

### Acceptance criteria

- [ ] A recurring pattern surfaces as prose plus a concrete suggestion, not a raw count.
- [ ] The four narrative output types (assessment, what-helped, skill-gap, routing) are accessible through the CLI.
- [ ] Patterns are ranked by signal strength so the most actionable rise first.
- [ ] Suggestions name a specific direction (e.g., "consider a skill that defines domain language up front"), not just "you should think about this."

---

## Phase 2.5: In-session judge invocation

**User stories**: 8.

### What to build

A Guidance skill that invokes `feedback assess` against the conversation in progress and feeds the result back to the in-session agent. Useful for long conversations where the engineer wants the agent to work with full evidence plus judgment, not just what it can recall in its own context.

### Acceptance criteria

- [ ] In a live session, the skill can invoke the judge against the current conversation and return the result.
- [ ] The result is structured enough for the in-session agent to use (signals named, narrative summarized, anchors referenceable).
- [ ] The skill respects the daemon's enabled-flag gate (does nothing if Feedback is off).
- [ ] Works at least on Claude; Codex coverage follows the per-harness transcript reader's coverage.

---

## Phase 3.1: Enforcement design

**User stories**: 17 (precondition).

### What to build

A design pass producing at least one Enforcement ADR (and a sub-PRD if useful) that settles the gate authoring contract, how gates register and install, how denial events flow into Feedback's capture pipeline, the relationship between Enforcement and Guidance, and the cross-harness story since each harness has different gating mechanisms. The output is enough architectural ground to start building reference gates without piecewise re-derivation.

### Acceptance criteria

- [ ] At least one Enforcement ADR is committed in the hub.
- [ ] The denial-event flow into Feedback's capture pipeline is documented and consistent with ADR-0006's gate-denial handling.
- [ ] The design covers Claude and Codex's gating mechanisms at minimum.
- [ ] The design addresses how a gate written for one harness ports (or doesn't) to another.

---

## Phase 3.2: First reference gate end-to-end

**User stories**: 17, plus extending 18.

### What to build

One reference gate ships in `regimen-enforcement` (for example, a protected-path guard that prevents the agent from editing specified paths). The gate emits a denial event that flows through the existing Feedback capture pipeline into the SQLite `gate_denials` table and is visible in `feedback show` for the affected session.

### Acceptance criteria

- [ ] The gate denies a triggering tool call in a live session, with a clear reason exposed to the agent.
- [ ] The denial event lands in SQLite's `gate_denials` table with the expected gate id, tool name, and reason.
- [ ] `feedback show` displays the denial inline with the surrounding events for the session.
- [ ] Installing the gate is documented as a small, repeatable step on at least Claude and Codex.

---

## Phase 3.3: Write-your-own gate framework and second reference gate

**User stories**: 17.

### What to build

A framework or pattern for writing new Enforcement gates, documented in the `regimen-enforcement` repo with a complete worked example. A second reference gate ships using that framework (for example, a command-pattern guard that blocks specific destructive shell commands). Cross-harness adapters where needed.

### Acceptance criteria

- [ ] The framework is documented with a working end-to-end example.
- [ ] A second reference gate ships using the framework.
- [ ] Both reference gates' denials flow into Feedback through the same pipeline.
- [ ] The gate-authoring docs explain how to test a new gate before installing it.

---

## Phase G.1 (Parallel, Guidance): Curated skills with adoption guide

**User stories**: 16.

### What to build

The `skills` repo publishes a curated set of Guidance skills with an installation and adoption guide. Per-harness adapters or instructions where each harness loads skills differently. Includes the in-session evidence skill from Phase 1.4 and the in-session judge skill from Phase 2.5 once those exist. Not gated by any other phase; can run in parallel.

### Acceptance criteria

- [ ] An engineer landing on the skills repo can install the curated skills for at least Claude Code and Codex.
- [ ] The repo's README explains what each skill does, when to use it, and how to adopt it.
- [ ] Each skill is tested or sanity-checked against its supported harnesses.

---

## Phase B.1 (Optional, Bridge): Bridge consumes SQLite plus reference Grafana dashboard

**User stories**: 22.

### What to build

The OTLP bridge realigns with ADR-0005: instead of tailing JSONL (its original pre-reframe design), it reads from SQLite. It emits OTLP logs, metrics, and traces from the same data the CLI reads. A reference Grafana dashboard ships showing live evidence-layer signals (recent activity, tool mix, compaction count, gate denials).

### Acceptance criteria

- [ ] The bridge runs and exports without errors when Regimen is live.
- [ ] Grafana shows live evidence-layer signals from the SQLite store, refreshing within the bridge's cadence.
- [ ] The bridge does not duplicate or block any data path; removing the bridge does not affect Regimen's correctness.
- [ ] A reference dashboard JSON is committed in the bridge repo and importable into a fresh Grafana instance.
