# Regimen project conventions

## Harness- and model-agnostic by default
Every Regimen artifact (schemas, event names, metrics, interfaces, configs) must hold for any agent CLI and any model, not just Claude Code. Harness-specific details live only at the capture/adapter edge, normalized immediately. Before settling any name or schema, ask: "does this hold for the other CLIs too?"

## Driver document and branching workflow
This hub repo holds the plans and the active driver document (e.g. `plans/codex-trial-readiness.md`); work runs from here across many short conversations, one per phase.

- Treat driver/plan docs as LIVING working-tree files: update them in place with Edit as work progresses. They will usually carry uncommitted local edits between conversations, and that is intentional, the file on disk is what the next conversation reads. Do NOT create a branch for doc-only changes, do NOT commit them on every iteration, and never commit or revert the driver doc's local edits on your own initiative.
- Commit the driver doc only when I explicitly ask (usually at a phase boundary); when I do, commit it straight to `main` here, no feature branch.
- Repos with actual code changes (e.g. `regimen-feedback`) still get a feature branch per phase, named for the phase/section, committed there and merged on my call.
