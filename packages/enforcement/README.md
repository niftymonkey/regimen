# @regimen/enforcement

The Regimen Enforcement instrument: the deterministic response lever. This is the `packages/enforcement` workspace package of the Regimen monorepo.

Enforcement removes the model's choice when asking has failed. Its primary artifact is an operator skill, `regimen-enforcement`, the act-beat helper that authors and wires the engineer's own deterministic mechanism on demand (a pre-tool gate, a permission rule, an output schema, a CI check, a pre-commit hook, a substitution). Regimen ships NO catalog of gates: a gate is the engineer's specific rule, authored Windows-safe in TypeScript by the skill, not a maintained Regimen product. A gate denies a tool call and stops there; a denial leaves an `is_error` tool-result in the harness transcript that Feedback already captures, so the LLM judge reads it from the conversation. The gate does not self-report the denial (see [ADR-0014](../../docs/adr/0014-enforcement-drops-the-gate-denial-emit-seam.md)).

## What the package holds

- `skills/regimen-enforcement/SKILL.md`: the act-beat operator skill (the package's primary user-facing artifact), bundled into `regimen install`.
- `src/install/gate-command.ts`, `src/install/gate-hooks.ts`: the reusable seams the skill calls at AUTHORING time to wire an authored gate onto the right per-harness pre-tool event (the deny-shape convention, the command builder, the planner, and the per-harness `GATE_PROFILES`).
- `tests/fixtures/rm-rf-gate.ts`: a wiring test fixture and documentation exemplar of the shape an authored `bun` gate takes. Not installed as product.

## Install

The monorepo's root `./install.sh` composes this instrument through `regimen install`, which lays down the `regimen-enforcement` skill (it wires no gates). The authored-gate wiring path is a library function the skill calls when the engineer confirms a gate, not a standalone command.

## Develop

```sh
bun install
bun run check    # typecheck + lint + format:check + test
```
