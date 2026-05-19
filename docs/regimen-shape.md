# The shape of Regimen

> What Regimen is, how it is shaped, and the boundaries around it. The load-bearing decisions are recorded in `docs/adr/`; the vocabulary is defined in `DOMAIN-LANGUAGE.md`.

## Problem

AI's value in software engineering is conditional, not intrinsic. What separates good software from slop is the engineer's process: framing work, bounding scope, supplying context, verifying, knowing what not to delegate. That process is usually tacit and unmeasured. Regimen makes it explicit, portable across any harness and model, and improvable through feedback.

## Target users

- Primary: an experienced software engineer, using Regimen daily on real work.
- Secondary: a workplace AI-tooling trial, which needs to know whether a given CLI and model help an engineer succeed. Regimen answers this as a by-product of its longitudinal feedback.
- Serving less-experienced engineers is an open question, not a requirement.

## What Regimen is

A practice for operating an engineer-and-AI-agent pair well. Its object is the interaction discipline between them, not the engineer and not the AI. It is delivered as pluggable instruments, adopted as felt needs arise. Two viewpoints hold at once: the adopting engineer sees only pluggable tools, while the design holds the discipline as the spine that gives those tools coherence.

## The three instruments

Cut by mechanism:

- **Guidance** (advisory): skills that encode good practice the agent is asked to follow. It instructs.
- **Enforcement** (mandatory): any mechanism that makes an outcome deterministic, not left to the model's discretion. It compels.
- **Feedback** (sensing): observes how the interaction went.

## Feedback, in detail

- Measures how well the AI did the work it was given, never whether the software is good.
- Measured object: the conversation, evaluated start-to-now, never waiting on a close.
- Two visible layers: the evidence layer (always-on deterministic facts and counts) and the judgment layer (an LLM-as-judge that reads the evidence and emits structured, drill-able signals plus an assessment, showing its work).
- Unit within a conversation: the assignment, classified by kind, rolling up by kind across conversations.
- Also produces forward-looking recommendations, such as routing (which model or harness for which kind of work).
- Stores its data in an open format that acts as a seam any tool can read.

How Feedback must surface what it captures is detailed in [`feedback-surfacing.md`](feedback-surfacing.md).

## The two loops

- **The tight loop** (fast): within work. Feedback makes the in-the-moment experience explicit and comparative; the engineer adjusts the next move (reframe, add context, invoke an existing skill, route differently). Changes behavior, not the kit.
- **The long arc** (slow): across many conversations. Rolled-up patterns drive durable changes to the instruments: a sharper skill, a new guardrail, a routing change. Changes the kit.

## Core requirements

Must-have: evaluate AI performance differentiated by kind of work; feedback at two timescales (the tight loop and the long arc); harness- and model-agnostic; instruments adopted individually with no wholesale adoption.

Optional: the OTLP bridge and any Grafana visualization.

## Repository topology

A program, multi-repo, because instruments are independently pluggable and installable.

- `regimen`: the hub (program docs, roadmap, `DOMAIN-LANGUAGE.md`, ADRs).
- `regimen-feedback`: the Feedback instrument.
- `regimen-enforcement`: the Enforcement instrument.
- `skills`: a curated set of high-value Guidance skills the author maintains. Guidance is skills generally; this repo is one good source of them.
- `regimen-otlp-bridge`: an optional renderer that reads Feedback's stored format and maps signals to OTLP for Grafana.

## Constraints and boundaries

- Harness- and model-agnostic; harness-specific detail confined to a thin capture/adapter edge.
- Feedback never grades software quality.
- "Context", the AI's standing knowledge, is a property of the interaction the instruments act on, not an instrument.

## Open questions

- The stored feedback data format: the shape of the open format Feedback writes and any tool reads.
- The long arc's "respond" step, turning a diagnosed pattern into a new skill or guardrail, is real engineering work owned by no instrument; how much Feedback assists it is undefined.
