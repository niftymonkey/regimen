# Regimen project conventions

## Harness- and model-agnostic by default

Every Regimen artifact (schemas, event names, metrics, interfaces, configs) must hold for any agent CLI and any model, not just Claude Code. Harness-specific details live only at the capture/adapter edge, normalized immediately. Before settling any name or schema, ask: "does this hold for the other CLIs too?"

## Restart the running service after merging code

The bridge is meant to run as a supervised service (a `systemd --user` unit on Linux and WSL; see the README). That service runs `src/cli.ts` from this working copy, and Bun loads the module code once at process start, so editing files or pulling commits does not change the running daemon.

After a change is merged into `main`, bring the running bridge up to date:

```
git checkout main && git pull
bun install   # only if dependencies changed
systemctl --user restart regimen-otlp-bridge
```

Confirm with `systemctl --user status regimen-otlp-bridge`; the daemon logs to `~/.local/share/regimen/bridge.log`. If no such service is installed on the machine, this step is a harmless no-op and can be skipped.
