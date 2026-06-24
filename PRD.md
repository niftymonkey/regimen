# Regimen PRD

> Program-level Product Requirements Document for Regimen as a whole, sitting above the per-instrument packages. Built on the problem and mental model in [`docs/mental-model.md`](docs/mental-model.md), and a companion to [`ARCHITECTURE.md`](ARCHITECTURE.md) (architectural overview) and [`docs/adr/`](docs/adr/) (decisions). This PRD focuses on who Regimen is for, what it does and does not do, and the use cases that drive each piece.

## Problem Statement

An engineer using an AI coding agent daily runs the whole interaction on feel. The agent's output depends as much on how the engineer frames work, supplies context, verifies results, and decides what to delegate as on the model itself, and that practice is the part the engineer actually controls. None of it is visible while it is happening, and only some of it leaves a trace afterward. The engineer carries impressions, not data: when the work goes badly they often cannot say why, and when it goes well they cannot reliably repeat what they did. Over weeks, missteps and patterns accumulate that the engineer would change if they could see them. Often they cannot.

A specific version of this bites when an engineer trials a new agent CLI or model. By the end of the trial, they have a vague impression of whether it served them and no evidence to point at. They learn at the end whether the choice was right, not in the middle when they could still adjust how they were using it.

There is no shortage of observability for the model itself, traces, latencies, token counts. There is almost no observability for the interaction between the engineer and the agent. Regimen exists to close that gap.

## Solution

Regimen instruments the interaction with the agent. Today the engineer runs that interaction on feel; Regimen turns the feel into data. That observability is **Feedback**, the center of Regimen: it observes how the work actually went and shows the engineer, plainly and comparably, where the interaction is strong and where it is weak. In response to what Feedback surfaces, the engineer reaches for a lever, each acting on the interaction by a different mechanism:

- **Guidance** instructs the agent through skills the engineer asks it to follow; the model may or may not comply.
- **Enforcement** compels an outcome through any mechanism that takes the choice away from the model: hooks, permission and tool gating, deterministic automation in place of the model, CI and pre-merge gates, sandboxing, schema-constrained outputs, workflow gates.

Adoption is incremental, never wholesale, but it is the levers that are adopted incrementally: a Guidance skill here, an Enforcement gate there, each added when a felt need calls for it, because engineers do not stop work to internalize a practice first. Feedback is not one more piece an engineer might pick up. It is the center, what turns those levers from a loose pile of skills and gates into something that improves, by showing whether a lever that was pulled is working, where Guidance is being ignored or absent, and where the model is doing something Enforcement could decisively prevent. In practice a lever often comes first, adopted on the engineer's own felt sense; Feedback is what replaces that felt sense with data.

The loop is see, act, validate. Feedback surfaces a pattern (see), the engineer pulls a lever in response (act), and Feedback shows whether it changed anything (validate), which is itself a fresh observation, so the loop closes. It runs at two ranges at once: the tight loop, in the flow of a single conversation, where the engineer (or the agent on their behalf, via a skill) adjusts the next move; and the long arc, across weeks of work, where rolled-up patterns drive durable changes to the kit, a new skill, a sharper guardrail, a routing change.

In experience terms, Regimen lives quietly. Feedback runs in the background once installed; the engineer reads it via a CLI when they want to reflect, or pulls signals into the agent during a conversation. A judgment pass produces a written assessment and a structured classification on demand, anchored to specific events so its claims are checkable. Conversations and signals live in a single local file the engineer owns and can inspect, copy, or delete. The only thing that leaves the machine is the LLM call used for judgment, and even that is, by default, the same LLM the engineer is already running their work with. Anyone who wants live dashboards instead of a CLI can install an optional renderer that visualizes the same data in Grafana.

## User Stories

### Daily use

1. As an engineer using AI agents daily, I want to install Feedback on my machine, so my agent sessions are captured for later reflection.
2. As an engineer in flow, I want to glance at how the current conversation is going, so I can adjust my next move without leaving the work.
3. As an engineer who has used Regimen for a while, I want recent signals automatically compared against my own past activity, so as my history accrues each signal sharpens against what is normal for me.
4. As an engineer, I want a list of recent conversations sorted so the ones worth reflecting on rise first, so my reflection time is well spent.
5. As an engineer, I want to drill into one conversation and see its event timeline, tool calls, gate firings, and repeated edits, so I can understand where it went sideways.
6. As an engineer mid-conversation, I want my agent to be able to pull deterministic evidence-layer signals from my recent work (via a Guidance skill), so it can self-correct without me feeding it context manually. These are counts and facts the agent reads directly from the local store; no judgment pass involved.
7. As an engineer, I want to invoke a judgment pass on a conversation and read an LLM-derived structured assessment plus a written narrative anchored to specific events, so I have a synthesis to act on rather than a transcript to re-read. This goes beyond evidence: the judge classifies and interprets, then shows its work against the deterministic anchors.
8. As an engineer in a long conversation that is starting to drift, I want to invoke that same judgment pass on the conversation in progress (via a Guidance skill), so the agent in this session can work with the full picture instead of only what I can recall.
9. As an engineer, I want each assignment in a conversation classified by intent (refactor, bug-fix, feature, test-writing, exploration, schema-change, and so on) and given an outcome, so I can roll up how an intent of work has been going across many conversations.
10. As an engineer, I want cross-conversation rollups by intent, so I can see whether an intent of work is trending toward clean accomplishment over weeks.
11. As an engineer, I want Feedback to surface a recurring pattern in plain language and offer a concrete suggestion of what to research, build, or invoke (a guidance skill, an enforcement gate, a routing change), so I have light help acting on the pattern.
12. As an engineer, I want a single toggle that turns Feedback off, so sensitive conversations are not captured at all.
13. As an engineer, I want Regimen to render an open conversation as open, never as if it ended, so the data never lies about state.

### Evaluating a new harness or model

14. As an engineer trying a new agent CLI or model over a sustained window, I want to see in-window whether it is serving me, so I can adjust my own behavior or my conclusions before the window closes.
15. As an engineer whose colleague sees what I am doing and wants to try it themselves, I want Regimen's setup to be clear and shareable, so I can hand it off without a long onboarding.

### Adopting Regimen

16. As an engineer, I want to install one instrument and use it without installing the others, so I can adopt Regimen as needs arise rather than wholesale.
17. As an engineer using Codex, Claude Code, Gemini CLI, Cursor, or any other supported harness, I want Regimen to work with my harness via a small per-harness adapter, so I am not forced to change CLIs to use Regimen.
18. As an engineer in a multi-harness world, I want signals comparable across harnesses (within each harness's availability), so a measurement is not tied to one CLI.
19. As an engineer who enjoys real-time observability, I want the option to install an OTLP bridge that renders Grafana dashboards from the same data, even though Regimen is fully usable without it.

### Trust and data ownership

20. As an engineer, I want my conversations and signals to live in one local file I can inspect, back up, copy, or delete, so I own my data.
21. As an engineer, I want Regimen to never send my agent conversations to anyone other than the LLM I am already using, so my work is not exfiltrated.
22. As an engineer, I want no telemetry sent to Regimen's authors about what I do with my own tool, anonymous or otherwise.
23. As an engineer, I want to purge accumulated data on demand, so I can start fresh or recover from an instrumentation mistake.

### Cross-platform

24. As an engineer working on Linux, macOS, or native Windows, I want Regimen to work on my OS, so I am not forced to change platform to adopt it.

### Future directions the architecture preserves

25. As an engineer (future), I want to share a redacted slice of my signals with a teammate, so we can compare approaches without compromising the local-only default.
26. As an engineer (future), I want Regimen to support team-shared signals if I opt in, so a group can roll up patterns across people.
27. As an engineer (future), I want a unified `regimen` installer that can add, remove, or update individual instruments, so adoption stays low-friction as the set of instruments grows.

## Implementation Decisions

Most program-level structure is settled in ADRs; this section names the decisions that hold across the program, not within any one instrument.

- **Single monorepo**, one Bun workspace with a package per instrument plus the bridge. The workspace root holds program-level artifacts (PRDs, ADRs, glossary) and the `regimen` installer, with the implementation plan under `docs/`; each instrument lives under `packages/`. Each package is independently installable, so adoption stays incremental rather than wholesale.
- **Feedback is the center; Guidance and Enforcement are the levers acted with in response to it.** Not three co-equal instruments. Settled in ADR-0013, which supersedes the co-equal framing of ADR-0001 and ADR-0002 while preserving their felt-needs adoption and the Guidance-versus-Enforcement boundary. The set of levers is open, not fixed at two.
- **Guidance and Enforcement are cut by mechanism, not by purpose.** What separates them is the reliability boundary between a skill the agent may or may not follow and a deterministic mechanism that takes the choice away. Settled in ADR-0002 for the boundary, as reframed by ADR-0013.
- **Regimen is embodied in pluggable instruments, not a methodology document.** Engineers do not stop work to internalize a practice before using it. Settled in ADR-0001.
- **Feedback measures the conversation, not the software.** Software quality is subjective and not Regimen's to judge. Settled in ADR-0003.
- **Feedback's data architecture.** Capture hook appends raw events to a local JSONL buffer; loader translates per-harness events into the canonical schema and writes them to a local SQLite store; SQLite is the source of truth for non-rebuildable state; conversation content stays in the harness's own transcript file, never duplicated. Settled in ADR-0005.
- **Feedback's loader is an opt-in always-on daemon.** Real-time freshness is the substrate. Per-harness translation is the only harness-specific seam. Capture and storage share one enabled-flag gate. First-class support for Linux, macOS, and native Windows. Settled in ADR-0006.
- **The judge LLM defaults to the engineer's already-configured agent LLM** in the first implementation. The configuration sits behind a seam that allows swapping in a different LLM later without changing callers.
- **Guidance is skills generally; the curated `skills` repo is one good source, not the canonical container.** Other sources (agent-CLI defaults, organization-curated sets, externally-published collections) are valid sources of Guidance.
- **The OTLP bridge consumes from SQLite.** Per ADR-0005. It is a separate optional renderer, not bundled with Feedback. Its own streaming-daemon architecture is sketched in the `packages/otlp-bridge` package; the realignment to ADR-0005 is tracked in the Bridge workstream.
- **The "respond" step of the long arc is in scope as light assistance, designed but not yet built.** When built, Regimen will surface patterns in plain language and offer concrete suggestions of what to research, build, or invoke; the engineer does the authoring.
- **A unified `regimen` installer composes the instruments.** The `@regimen/cli` package dispatches to each instrument's install logic in-process (Feedback, then Enforcement); each instrument can still be installed on its own. Settled in ADR-0012.

## Testing Decisions

- **Tests live in each package, at the instrument's external interface.** Each package owns its own tests; the interface (CLI commands, the capture-hook contract, the event schema, the SQLite schema) is the test surface.
- **The `@regimen/cli` package is tested at its CLI interface.** The unified installer's tests exercise its install and uninstall verbs, not its internal modules.
- **Highest-leverage test surfaces in the feedback package.** The translator interface (per-harness mapping is the only harness-specific seam, so tests are the safety net for adding harnesses); the segment reader (idempotency and crash recovery are correctness-critical); the SQLite schema (a stable contract every downstream reader depends on).
- **What makes a good test in this codebase.** External-behavior assertions through the module's interface; tests should survive internal refactors. A test that must change every time the implementation changes is testing past the interface and should be redesigned at the seam.

## Out of Scope

- Grading software quality. Settled in ADR-0003.
- Adopting a methodology wholesale; reading a document and following its rules. Settled in ADR-0001.
- Managing the AI's standing context for it. Settled in ADR-0002; context is a property of the interaction the instruments act on.
- Benchmarking models or harnesses head-to-head as a Regimen feature. Regimen can be used by an engineer to evaluate a harness, but is not designed as a comparative benchmark suite.
- Multi-user or shared-team data in current scope. Single-user only today; team or aggregation use cases are future directions the architecture leaves room for, not commitments.
- Telemetry to Regimen's authors about user behavior, anonymous or otherwise.
- Authoring kit changes on the engineer's behalf. Light assistance is in scope: a pattern surfaced in plain language plus a concrete suggestion of what to research, build, or invoke. Turning that suggestion into a working skill or gate is the engineer's work.
- Native real-time LLM judgment without an explicit invocation. The architecture preserves room for it; no implementation in current scope.
- Active service to less-experienced engineers as a target audience for Feedback or Enforcement. Guidance is broadly useful regardless of experience; Feedback and Enforcement assume more user judgment. The PRD reframes the audience by instrument rather than committing the program to less-experienced engineers as a whole.

## Further Notes

### Audience by instrument

Regimen does not have one audience uniformly. Guidance, skills the agent is asked to follow, is broadly useful regardless of how experienced the engineer is; a junior engineer benefits from a well-written skill just as a senior does. Feedback and Enforcement assume the engineer has the judgment to act on signals and to decide what to enforce; they are not designed against less-experienced engineers, but they are not actively serving them either.

### Phases of value

What the engineer can do when each phase lands:

- **Phase 1 (Feedback's evidence layer plus a CLI).** List conversations worth reflecting on, drill into one, and pull evidence-layer signals into the current conversation via a Guidance skill. The tight loop becomes usable.
- **Phase 2 (Feedback's judgment layer).** Read a per-conversation assessment narrative, see each assignment classified by intent and outcome, and cross-conversation rollups by intent start to make the long arc legible.
- **Phase 3 (Enforcement).** Install a small set of reference gates (a guard against `rm -rf`, a guard against editing protected paths, and so on) and write your own. Routing suggestions from Feedback help decide which gates matter for which intent of work.
- **Parallel (Guidance).** Adopt curated skills as needs arise. Not gated by Feedback or Enforcement phases.
- **Optional (Bridge).** Install the OTLP bridge for live visibility outside the CLI when wanted.

The current external forcing function for Phase 1 and Phase 2 timing is a workplace harness trial the author is participating in.

### Three near-future use cases the architecture preserves

These are not commitments for any near-term phase, but the loader's daemon shape and SQLite-as-substrate are designed to support them:

- An in-session Guidance skill that queries SQLite for evidence-layer signals so the in-conversation agent can self-correct mid-work.
- A Guidance skill that invokes the judge on-demand mid-conversation, so the in-session agent works with full evidence and judgment.
- A Grafana dashboard via the OTLP bridge that reflects both layers in near-real-time, because the bridge reads the same fresh SQLite the rest of Regimen reads.

### Relationship to existing docs

This PRD does not supersede the existing hub docs; it layers above them.

- [`docs/mental-model.md`](docs/mental-model.md) is the conceptual source of truth for the problem and the model (Feedback the center, the levers, the see/act/validate loop); this PRD's problem framing derives from it.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) is the architectural overview.
- `feedback-surfacing.md` is the design of what Feedback surfaces and the principles its surfaces follow.
- `DOMAIN-LANGUAGE.md` is the vocabulary.
- `docs/adr/` is the decision log.
- [`docs/plan.md`](docs/plan.md) is the engineering-sequence view of the implementation phases. The phases-of-value above are the user-value view; the two should align, and where they do not, this PRD wins.

The PRD is the canonical statement of Regimen's requirements: who it is for, what it does and does not do, and the use cases that drive each piece. The problem and the conceptual model it builds on are owned by [`docs/mental-model.md`](docs/mental-model.md). The other docs are authoritative for what they cover.
