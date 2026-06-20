# Regimen architecture

> The architectural overview of Regimen at the program level. For what Regimen is for and who it is for, see [`PRD.md`](PRD.md). For the vocabulary, see [`DOMAIN-LANGUAGE.md`](DOMAIN-LANGUAGE.md). For the load-bearing decisions behind each piece, see [`docs/adr/`](docs/adr/).

## The three instruments

Regimen has three instruments, cut by the mechanism each uses on the interaction:

- **Guidance** instructs the agent through skills it is asked to follow.
- **Enforcement** compels an outcome through any deterministic mechanism that takes the choice away from the model.
- **Feedback** observes how the work actually went and surfaces where the interaction is strong or weak.

The cut by mechanism (rather than by purpose) is the load-bearing decision: it preserves the reliability boundary between an advisory skill and a deterministic mechanism even when both target the same outcome. Settled in ADR-0002.

## Feedback's two layers

Feedback has two visible layers, both anchored to the same evidence:

- **Evidence layer.** Always-on deterministic facts and counts derived from the interaction.
- **Judgment layer.** An LLM reading the evidence and emitting structured signals plus a written assessment, with claims anchored to specific events.

The unit Feedback measures is the assignment, classified by intent and rolled up by intent across conversations. Feedback measures the conversation, not the software, since software quality is not Regimen's to judge. Settled in ADR-0003.

Feedback's data architecture (capture hook, JSONL buffer, loader, SQLite store) is settled in ADR-0005; the loader runs as an opt-in always-on daemon per ADR-0006. What Feedback surfaces and how is detailed in [`docs/feedback-surfacing.md`](docs/feedback-surfacing.md). The instrument's own operational health, what a healthy install looks like and what `feedback status` should surface, is specified in [`docs/feedback-health.md`](docs/feedback-health.md).

## The two loops

Two feedback loops close over the interaction:

- **Tight loop.** In the flow of work. The engineer (or the agent on their behalf, via a skill) reads recent signals and adjusts the next move with the existing kit.
- **Long arc.** Across many conversations. Rolled-up patterns inform durable changes to the kit, a new skill, a sharper guardrail, a routing change. Regimen offers light assistance for the respond step, surfacing the pattern and suggesting what to research, build, or invoke.

What the engineer can do when each phase of Regimen lands is detailed in the PRD's "Phases of value" section.

## Package topology

Regimen is a single Bun-workspace monorepo. Each instrument is a workspace package, kept independently pluggable so an engineer can adopt one without the others.

- The workspace root holds the program docs (PRD, ADRs, glossary, roadmap, this shape doc) and the `./install.sh` front door.
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
