# Regimen: program roadmap

**Regimen** is the program: building, and then running, a deliberate practice of engineering with AI agents. It has three layers: **Practice** (a curated skill library), **Observability** (a telemetry layer plus an evaluation tier), and **Shepherd** (guardrails and human-in-the-loop routing), plus the tooling that ties them together. This roadmap is the program-level view: the workstreams, their state, the rough order, and the epics that seed the tracking board.

It started narrower: sharpen the skill library for an internal Gemini CLI trial. It grew into a system the operator wants for themselves first, and applies to the trial second.

## How this is tracked

Regimen is a program, not a single project. The tracking structure (full method: https://md.niftymonkey.dev/v/mKkKAEQl):

- A **hub repo** (`niftymonkey/regimen`) holds the program docs and the epic-level issues.
- One **GitHub Project board** spans every repo.
- Each **workstream** is roughly one repo, with its own PRD and issues.
- **Everything is an issue**, including decisions and design passes, distinguished by Status, not by whether it is a code task.

## Workstreams

| Workstream | Repo | What it is | State |
|---|---|---|---|
| Program (cross-cutting) | `niftymonkey/regimen` (new hub) | Roadmap, design docs, board, epics | Being set up |
| Practice | `niftymonkey/claude` and `niftymonkey/skills` | The curated skill library and its publishing pipeline | Evaluated; finish-and-publish work outstanding |
| Observability | `regimen-observability` | Two-tier telemetry plus evaluation module | Architecture designed and settled |
| Visualization | `regimen-otlp-bridge` | The Grafana bridge: JSONL telemetry to OTLP into Grafana Cloud | Sketched; needs a short design pass |
| Shepherd | `regimen-shepherd` (later) | Guardrails and human-in-the-loop routing | Framed only; not yet designed |

## Sequencing

Rough order. Practice runs as a parallel track; the rest is roughly sequential.

- **Phase 0, program setup.** Create the hub repo, stand up the board, land this roadmap, open the epics. (Cross-cutting.)
- **Phase 1, first light.** The tracer bullet: capture one minimal event, write it to JSONL, run it through the Grafana bridge, see one panel in Grafana Cloud. Proves the whole pipe end to end thin and delivers immediate visualization. (Observability Tier 1 and Visualization, both minimal.)
- **Phase 2, Observability Tier 1 full.** The full event schema, the seven counted metrics, the three signal projections (logs, metrics, traces), the surfacing interface. Grafana dashboards filled out.
- **Phase 3, Observability Tier 2.** The evaluator: judged metrics, deep review, rollup verdict. This is what the Gemini trial leans on.
- **Phase 4, Shepherd.** A design pass first, then build. Last, because it benefits from observability data and the established hook substrate.
- **Parallel, Practice.** Finishing and publishing the skill library is not gated by observability and runs alongside Phases 0 to 3.

**External driver:** the Gemini CLI trial wants Phases 2 and 3 usable by trial time, which pulls observability ahead of Shepherd.

## Epics

These seed the hub repo as epic issues; implementation issues land in the workstream repos and link up.

- **Stand up the Regimen program** (Cross-cutting): hub repo, board, roadmap, epics.
- **Finish and publish the skill library** (Practice): the outstanding evaluation, refactor, and publishing work.
- **Observability Tier 1: telemetry layer** (Observability): capture, event log, surfacing as logs, metrics, and traces.
- **Observability Tier 2: evaluation layer** (Observability): the evaluator, judged metrics, deep review, rollup verdict.
- **Grafana bridge** (Visualization): JSONL to OTLP, telemetry into Grafana Cloud.
- **Design Shepherd** (Shepherd): the guardrail layer's architecture.
- **Build Shepherd** (Shepherd): implement the guardrail layer.

## Open decisions

Real, trackable items that are not yet tasks. Each becomes a "Needs decision" or "Needs design" issue on the board.

- The judged-metrics JSON schema: the exact fields and shape.
- The evaluator's default cadence for producing judged metrics automatically.
- The rollup verdict's structured shape.
- Grafana bridge: a bespoke service, or an OpenTelemetry Collector configuration plus a schema mapping. The Collector route is likely the smaller piece of work and should be scoped before tasking.
- Whether the evaluation tier ships inside the observability repo or as a clearly separate component within it.
- Shepherd needs a full design pass before it can become a PRD.

## Status

Phase -1 of the original effort is complete: the skill library was evaluated and the observability architecture was designed and settled. Regimen as a program is now in Phase 0, being set up.

Design records:
- Pitch: https://md.niftymonkey.dev/v/9s4liAxL
- Observability architecture: https://md.niftymonkey.dev/v/pdGcjATO
- Tracking method: https://md.niftymonkey.dev/v/mKkKAEQl
