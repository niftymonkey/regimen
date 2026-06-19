# Regimen project conventions

## GitHub CLI in Codex
Use the WSL2 `gh` CLI for GitHub work. It is installed at `/home/linuxbrew/.linuxbrew/bin/gh` and is authenticated for the `niftymonkey` account. If a sandboxed `gh` command says the token is invalid, GitHub is unavailable, or the CLI is unavailable, first suspect the Codex network sandbox. Re-run the same `gh` command with escalated network permission before treating `gh` as missing or unauthenticated.

## Harness- and model-agnostic by default
Every Regimen artifact (schemas, event names, metrics, interfaces, configs) must hold for any agent CLI and any model, not just Codex. Harness-specific details live only at the capture/adapter edge, normalized immediately. Before settling any name or schema, ask: "does this hold for the other CLIs too?"
