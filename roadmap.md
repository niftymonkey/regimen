# Regimen: program roadmap

Regimen is a program: tools for working well with AI coding agents, built as three instruments (Guidance, Enforcement, Feedback) plus the hub that ties them together. This roadmap is the engineering-sequence view: the workstreams, their state, and the rough order of work. For what Regimen is for and who it is for, see [`PRD.md`](PRD.md). For architecture and topology, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Principles

- **Harness- and model-agnostic by default.** Every Regimen artifact (schemas, event names, signals, interfaces, configs) must hold for any agent CLI and any model. Harness-specific detail is confined to a thin capture/adapter edge and normalized immediately. This rule is pinned in `CLAUDE.md` at the root of every Regimen repo.

## Workstreams

| Workstream | Repository | What it is | State |
|---|---|---|---|
| Hub | `regimen` | Program docs, roadmap, ADRs, glossary, PRD | Active |
| Guidance | `skills` | Curated, high-value skills the agent is asked to follow | Mature; curation ongoing |
| Feedback | `regimen-feedback` | Capture, the evidence layer, the judgment layer, the SQLite store, a default CLI | Capture pipeline proven end to end; loader, evidence and judgment layers to build |
| Enforcement | `regimen-enforcement` | Deterministic mechanisms that remove the model's discretion, plus an installer | Defined; design pass pending |
| Bridge | `regimen-otlp-bridge` | Optional renderer: visualizes Feedback's signals in Grafana | Exists; optional |

## Sequencing

Feedback is the active build. Enforcement follows. Guidance runs in parallel.

- **Phase 1, Feedback: the evidence layer.** Capture conversation events across harnesses into the SQLite store; surface the deterministic facts and counts; ship a default CLI. The always-on substrate the rest of Feedback sits on.
- **Phase 2, Feedback: the judgment layer.** The LLM-as-judge: segment conversations into assignments, classify each by intent, emit drill-able signals and an assessment, and produce routing recommendations. With both layers live, the tight loop and the long arc are usable.
- **Phase 3, Enforcement.** A design pass first, then build: a small set of reference gates plus tooling to write new ones.
- **Parallel, Guidance.** Curating and publishing high-value skills. Not gated by the other workstreams.

The Bridge is maintained as an optional renderer alongside Feedback, not a phase of its own.

What the engineer can do when each phase lands is described in [`PRD.md`](PRD.md) under "Phases of value."

**External driver.** A workplace AI-tooling trial needs Feedback's longitudinal evaluation to judge whether a given CLI and model help an engineer succeed. That pulls Phases 1 and 2 ahead of Enforcement.

## Open questions

- Realigning the `regimen-otlp-bridge` with ADR-0005 (the streaming-daemon design predates the reframe and assumed a JSONL-tailing source; the bridge now consumes SQLite). Tracked as [regimen#16](https://github.com/niftymonkey/regimen/issues/16).

## Tracking

Regimen is a multi-repo program. A single GitHub Project board spans every repo; each workstream is roughly one repository with its own issues; decisions and design passes are tracked as issues, distinguished by status. The reusable method is written up at https://md.niftymonkey.dev/v/mKkKAEQl.

Board: https://github.com/orgs/niftymonkey/projects/9
