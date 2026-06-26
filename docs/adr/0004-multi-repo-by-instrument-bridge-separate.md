# Multi-repo by instrument; the OTLP bridge is a separate optional renderer

> Status: accepted (2026-05-18)

Regimen is a multi-repo program because its instruments are independently pluggable and installable, and a monorepo would fight that. The repos are `regimen` (the hub), `regimen-feedback` (the Feedback instrument), `regimen-enforcement` (the Enforcement instrument), and `skills` (a curated set of high-value Guidance skills; Guidance is skills generally, and this repo is one good source of them). The OTLP bridge stays its own repo, `regimen-otlp-bridge`, as an optional renderer.

Update: `regimen-enforcement` is now realized, created and deployed alongside `regimen-feedback`, no longer a planned repo.

Update: the multi-repo and independently-pluggable-instruments framing here is superseded. ADR-0010 consolidated the instruments into one Bun-workspace monorepo, and ADR-0013 makes Feedback the center with Guidance and Enforcement as the levers acted with in response, not three co-equal pluggable instruments. The `skills` repo is one source of Guidance examples, not a canonical curated catalog (see `../mental-model.md`).

## Considered options

- A monorepo. Rejected: fights the independent installability of instruments.
- Folding the OTLP bridge into Feedback. Rejected: the bridge is optional and externally integrated (OTLP, Grafana, its own secrets and deployment); bundling it would force it on everyone who only wants Feedback. Feedback stores its data in an open format that acts as a seam, so the bridge, and other renderers, can read it from a separate repo.
