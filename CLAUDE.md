# Regimen project conventions

## Harness- and model-agnostic by default
Every Regimen artifact (schemas, event names, metrics, interfaces, configs) must hold for any agent CLI and any model, not just Claude Code. Harness-specific details live only at the capture/adapter edge, normalized immediately. Before settling any name or schema, ask: "does this hold for the other CLIs too?"
