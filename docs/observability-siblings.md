# Observability and its siblings: design decisions

The decisions record for the observability layer and how it sits alongside its two sibling layers. The full module-level architecture lives in [`docs/architecture/observability-module.md`](./architecture/observability-module.md) (rendered: https://md.niftymonkey.dev/v/pdGcjATO). This document is the *relationship and positioning* record: what the three layers are, how they depend on each other, and where each one lives.

## The three layers

Three composable, harness-agnostic layers for engineering with AI. Each one is standalone: independently useful, independently installable.

- **Practice.** The foundation. A curated, opinionated set of skills that encode how to work well with an AI agent. The artifacts are still called *skills*; **Practice** names the curated collection. Everyone starts here, whether with a harness's built-in skills or skills they install.
- **Observability.** Telemetry from every session, and the ability to reason about it objectively. Captures what happened, synthesizes it out-of-session, and surfaces metrics and plain-English recaps. The easy add-on once a practice exists.
- **Shepherd.** The optimization layer. Guardrails that make it harder for an agent to go off the rails, plus the judgment to route what needs a human in the loop versus what a capable model can validate itself. Progressively enhances as harnesses and models get more capable.

**Adoption order** is forced by the model: you need a practice before you can observe it, and you observe before you know what to control. Practice, then Observability, then Shepherd.

**The loop.** The three are independent artifacts but form one improvement cycle: you bring your practice, observability shows you how it actually went, and you respond by sharpening a skill or adding a Shepherd guardrail. The loop is what makes them a system rather than three unrelated tools. It compounds.

## How the layers relate

- **Dependency directions.** Practice is the base. Observability and Shepherd both build on the **hook substrate**, the cross-harness mechanism of registering shell commands on session events. Observability and Shepherd have **no structural dependency on each other**: Shepherd works without observability; observability works without Shepherd.
- **The event schema is owned by Observability.** It is observability's *semantic convention*: the stable, versioned, cross-harness format that keeps Claude, Codex, and Gemini data comparable. When Shepherd's guardrail hooks fire, they *optionally emit events in observability's schema* so their firings can be captured. This is a one-directional convention ("conform if you want to be observed"), not a dependency.
- **Two real but non-structural couplings.** (1) Informational: observability data informs which skill patterns are worth lifting into Shepherd hooks. (2) Scheduling: the Gemini trial needs observability data to produce trial feedback, so observability and Shepherd get co-developed in parallel. Neither coupling may be hardened into a code dependency.
- **Visualization is not a sibling layer.** An earlier framing treated visualization as a third sibling module. It is not: it is an *optional renderer inside Observability*, built over observability's surfacing interface. It may be built several ways or never; observability is fully usable without it (syntheses are human-readable markdown, and the default metrics CLI ships in the box).

## Observability: design summary

Two tiers (full detail in the architecture doc):

**Tier 1: Observability (telemetry, no AI).** A capture hook in each harness's hook config appends events continuously to one append-only JSONL log. Surfacing projects that log, on read, into the three OpenTelemetry signal shapes: logs (the event stream), metrics (counts over events), and traces (a session as a span tree). Deterministic end to end. There is no trigger and no separate running service; capture is the harness invoking a hook.

**Tier 2: Evaluation (AI, reads the telemetry).** One LLM seam with three jobs: judged metrics (four LLM-computed metrics emitted as structured data that joins the metric space), deep review (an on-demand readable narrative for a chosen slice, the notes-equivalent), and a rollup verdict (an on-demand objective assessment across many slices, such as how the Gemini trial went). Every job reads telemetry as its primary input, not raw conversation, which is the objectivity guarantee.

**Units are read-time slices**, not a fixed boundary. The telemetry is unit-agnostic; a slice is chosen on read: time window, session id, compaction segment, or checkpoint. Sessions run through many compactions and rarely end cleanly, so no single fixed unit would hold.

**OpenTelemetry-shaped decisions:**

- **Model is a first-class attribute, distinct from harness.** The goal is "is this *model* working for me," and harness is not the same as model. Capture `harness`, `model`, and `model_version` as separate fields.
- **The three signal shapes are projections of one log.** Logs, metrics, and traces are computed from the single append-only event log on read, not stored separately.
- **The event schema is a versioned semantic convention.** It is the keystone artifact for cross-harness comparability and carries span fields so the flat log reconstructs into traces.

## Repository decisions

- **Observability gets its own repository.** It is a different *shape* from the Practice skills library: a tool (hooks, an evaluation runner, a CLI, a schema spec), not a library of `SKILL.md` files. A separate repo enforces the boundary, allows independent versioning, and gives it an independent install path.
- **Observability ships its own `install.sh`.** Its capture hooks must be *registered* in each harness's config (Claude `settings.json`, Codex `config.toml`, Gemini `settings.json`), a config change a file-copy installer like `npx skills` cannot do. The install script is observability's analog of the skills installer: one command, adds the hooks.
- **The installer is separable from repo count.** Observability and Shepherd are *not* co-located just for installer convenience; each ships its own install script. Shepherd's repository is a later decision (Shepherd does not exist yet); when built, it reuses observability's install technique. Folding the two together remains an option if it later earns it.
- **The event schema lives in the observability repository**, since observability owns it.

## Naming

- **Practice, Observability, Shepherd.** Practice and Observability are discipline terms and pair naturally. Shepherd is a metaphor, kept deliberately: it is the strongest and most recognizable of the three names, and the register mismatch was judged an acceptable cost.
- **"Skills"** remains the term for the individual artifacts; **"Practice"** names the curated collection, avoiding the overload of "skills" against harness-builtin skills and the `SKILL.md` format.

## Status

- **Observability architecture.** Designed (Phase -1, Step 8). Open: whether to run a parallel interface-design pass on the `Synthesizer` port before the build plan.
- **Shepherd.** Designed at a high level; its repository decision is deferred until it is built.
- This document supersedes the earlier "shepherd / observability / visualization = three modules" framing: the three *layers* are Practice, Observability, and Shepherd, and visualization is an optional component of observability.
