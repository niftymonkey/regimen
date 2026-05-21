# Regimen

*Tools for working well with AI coding agents.*

AI's value in software engineering is conditional, not intrinsic. What separates good software from slop is not the model, it is the engineer's process: how work is framed, how context is supplied, how output is verified, what is and is not handed to the agent. Regimen makes that process explicit, portable across any agent CLI and any model, and improvable.

Working well with an AI agent is a practice. Regimen makes it concrete: a set of instruments you pick up one at a time, each earning its place by meeting a need you already feel.

## The three instruments

- **Guidance**: skills that encode good practice the agent is asked to follow. It instructs.
- **Enforcement**: any mechanism that makes an outcome happen deterministically, not at the model's discretion. Hooks, permission and tool gating, sandboxing, CI and pre-merge gates, schema-constrained outputs. It compels.
- **Feedback**: the instrument that watches how the work actually went and shows you, plainly and comparably, where the interaction is strong and where it is weak. It observes.

Each is adopted on its own. Guidance alone is useful. Add Enforcement when you need something to happen without fail. Add Feedback when you want to know whether any of it is working and what else might need to be added or sharpened.

## The loop

At the center is the interaction itself: you and the AI agent doing the work. Guidance and Enforcement shape it; Feedback observes it and closes two loops.

```mermaid
flowchart LR
    subgraph KIT["shaping instruments"]
        G["Guidance"]
        E["Enforcement"]
    end
    KIT --> I(["the interaction:<br/>you and the AI agent"])
    I --> F["Feedback"]
    F -.->|tight loop| I
    F -.->|long arc| KIT
```

- **The tight loop** runs in the flow of work. Feedback shows how the current work is going, and you adjust your next move with the existing kit.
- **The long arc** runs across weeks. Patterns roll up, and you make a durable change to your kit: a sharper skill, a new guardrail, a routing change.

## This repository

Regimen is a program. This hub holds the program-level artifacts; the instruments live in their own repositories:

- [`regimen-feedback`](https://github.com/niftymonkey/regimen-feedback): the Feedback instrument.
- [`regimen-enforcement`](https://github.com/niftymonkey/regimen-enforcement): the Enforcement instrument.
- [`skills`](https://github.com/niftymonkey/skills): high-value Guidance skills, curated and published by the author.
- [`regimen-otlp-bridge`](https://github.com/niftymonkey/regimen-otlp-bridge): an optional renderer that visualizes Feedback's signals in Grafana.

See [`PRD.md`](PRD.md) for what Regimen does and for whom, [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it is structured, and [`docs/adr/`](docs/adr/) for the decisions behind it.
