# Regimen architecture

> The architectural overview of Regimen at the program level. For the problem and the mental model behind all of it, see [`docs/mental-model.md`](docs/mental-model.md). For what Regimen is for and who it is for, see [`PRD.md`](PRD.md). For the vocabulary, see [`DOMAIN-LANGUAGE.md`](DOMAIN-LANGUAGE.md). For the load-bearing decisions behind each piece, see [`docs/adr/`](docs/adr/).

## The instruments: Feedback at the center, Guidance and Enforcement as levers

Regimen has three instruments, but they are not three co-equal pillars. Feedback is the center, the observability that is the reason the whole thing exists. Guidance and Enforcement are the two levers you reach for in response to what Feedback surfaces.

- **Feedback** observes how the work actually went and surfaces where the interaction is strong or weak. This is the center.
- **Guidance** offers the agent something to work with, a skill, a standing-instruction line, or an MCP server or CLI it can use. A lever: it asks.
- **Enforcement** compels an outcome through any deterministic mechanism that takes the choice away from the model: a hook or gate, a permission boundary, a CI check, a sandbox, schema-constrained output. A lever: it compels.

The levers are cut by mechanism (advisory versus deterministic), not by purpose, even when both target the same outcome. That cut is the load-bearing reliability boundary, settled in ADR-0002.

The levers are categories of response, not catalogs Regimen ships. Guidance and Enforcement name the two kinds of move (ask the model, or compel it); the actual contents are the engineer's own, drawn from their own Feedback, often subjective and often harness-specific. Much of that content lives outside this repo: Guidance skills come from the external `skills` repo, from harness built-ins, and from wherever each engineer sources them. The repo reflects this asymmetry, with Feedback substantial here, Enforcement a few reference gates plus the wiring to install them, and Guidance largely pointers outward. The reference gates Regimen includes are starter examples, not a fixed menu; the bundled feedback skills are not Guidance examples but Regimen's own infrastructure. ADR-0013 records this structural decision (Feedback the center, the levers in response), superseding the co-equality of ADR-0001 and ADR-0002 while preserving their felt-needs adoption and the Guidance-asks / Enforcement-compels boundary.

## Feedback's two layers

Feedback has two visible layers, both anchored to the same evidence:

- **Evidence layer.** Always-on deterministic facts and counts derived from the interaction.
- **Judgment layer.** An LLM reading the evidence and emitting structured signals plus a written assessment, with claims anchored to specific events.

The unit Feedback measures is the assignment, classified by intent and rolled up by intent across conversations. It measures the conversation, not the software (software quality is subjective and not Regimen's to judge), and never renders a verdict on the engineer. What it surfaces is specific, localized, and grounded in what actually happened, never vague coaching. The conversation-not-software boundary is settled in ADR-0003.

Feedback's data architecture (capture hook, JSONL buffer, loader, SQLite store) is settled in ADR-0005; the loader runs as an opt-in always-on daemon per ADR-0006. What Feedback surfaces and how is detailed in [`docs/feedback-surfacing.md`](docs/feedback-surfacing.md). The instrument's own operational health, what a healthy install looks like and what `regimen daemon status` should surface, is specified in [`docs/feedback-health.md`](docs/feedback-health.md).

## The loop, across two time ranges

The loop is one cycle: see, act, validate. Feedback surfaces a pattern you would otherwise only feel (see); you pull a lever, building or adjusting a skill or adding a gate (act); Feedback shows whether what you built changed anything (validate). Regimen owns the seeing; you own the acting. The same cycle runs across two time ranges:

- **Tight loop.** In the flow of work. The engineer (or the agent on their behalf, via a skill) reads recent signals and adjusts the next move with the existing kit.
- **Long arc.** Across many conversations. Rolled-up patterns inform durable changes to the kit: a new skill, a sharper guardrail, a routing change.

The tight loop and the long arc are time ranges over the same see/act/validate cycle, not two different loops. Light assistance for the respond step (surfacing the pattern and suggesting what to research, build, or invoke) is designed but not yet built.

What the engineer can do when each phase of Regimen lands is detailed in the PRD's "Phases of value" section.

## Package topology

Regimen is a single Bun-workspace monorepo, one workspace package per instrument. The packages stay independently installable, but pluggability is about the levers: Feedback is the center an engineer runs, and Guidance and Enforcement are adopted incrementally on top of it, not three co-equal pieces picked in any order.

- The workspace root holds the program docs (PRD, ADRs, glossary, this shape doc), with the implementation plan under [`docs/plan.md`](docs/plan.md), and the `./install.sh` front door.
- [`packages/cli`](packages/cli): the `@regimen/cli` package, whose `regimen` bin orchestrates installing the instruments.
- [`packages/feedback`](packages/feedback): the Feedback instrument.
- [`packages/enforcement`](packages/enforcement): the Enforcement instrument.
- [`packages/otlp-bridge`](packages/otlp-bridge): an optional renderer that visualizes Feedback's signals in Grafana.
- [`packages/shared`](packages/shared): the cross-package contracts the instruments share (`@regimen/shared`).
- [`skills`](https://github.com/niftymonkey/skills): a curated source of Guidance skills the author maintains, installed separately; Guidance is skills generally, this is one good source.

## Constraints and boundaries

- **Harness- and model-agnostic by default.** Every artifact (schemas, signals, interfaces, configs) holds across harnesses; harness-specific detail is confined to a thin capture/adapter edge per harness.
- **Local-only by default.** All data lives on the engineer's machine. The LLM call used by the judgment layer is the only network egress; no telemetry is sent to Regimen's authors.
- **Single-user in current scope.** Team-shared or aggregated use cases are future directions the architecture leaves room for, not commitments.
- **First-class on Linux, macOS, and native Windows.** WSL is treated as Linux.
- **Context is a property of the interaction, not an instrument.** The AI's standing knowledge is something the instruments act on; it is not itself an addition Regimen makes.
