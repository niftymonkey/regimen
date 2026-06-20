# @regimen/otlp-bridge

The optional renderer that visualizes Regimen's Feedback signals in Grafana. This is the `packages/otlp-bridge` workspace package of the Regimen monorepo.

The bridge is a long-running daemon. It reads the Feedback SQLite store the rest of Regimen writes (per ADR-0005) and streams its evidence-layer signals to Grafana Cloud as all three OpenTelemetry signals: logs, metrics, and traces. Regimen is fully usable without it; the bridge is for engineers who want live dashboards instead of the CLI.

This is a TypeScript project; it runs on [Bun](https://bun.sh).

## What it does

The Feedback loader writes `feedback.db`, a WAL-mode SQLite store, and keeps it fresh in near-real-time. The bridge opens that store read-only, alongside the loader's writes, and on a poll cadence projects new rows into OTLP and delivers them to Grafana Cloud directly. No OpenTelemetry Collector is involved.

| OTLP signal | Source table                                                 | Shape                                                                                 |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Logs        | `events`                                                     | One log record per event, carrying its trace id                                       |
| Metrics     | `conversation_counts`, `repeated_file_edits`, `gate_denials` | Cumulative per-session counters and a file-churn gauge                                |
| Traces      | `conversations`, `tool_call_spans`, `events`                 | Session spans, tool spans, and point spans for prompts, compactions, and gate denials |

**Honest over tidy.** An open conversation emits no session span; an open tool call emits no tool span; a point event whose session has not closed still emits and renders as a rootless trace. The bridge never force-closes a span, never default-zeros an absent signal, and never invents a timestamp. An unfinished session looks unfinished.

The judgment-layer signals (Regimen Phase 2) are not yet produced upstream; the bridge surfaces evidence-layer signals only.

## Running it

The bridge resolves `feedback.db` from the OS-standard Regimen data directory (the same one `feedback` writes). Start the Feedback loader first (`feedback start`), then run the bridge.

```
bun install
bun run start            # stream to Grafana Cloud
bun run start --dry-run  # log what would be sent, deliver nothing
```

`--dry-run` is a preview: it reads the live store and reports per-tick payload counts, but sends nothing and keeps its watermarks in memory, so it never advances the state a real run resumes from.

### Configuration

Grafana Cloud credentials go in a gitignored `.env`, which Bun loads automatically:

```
GRAFANA_CLOUD_OTLP_ENDPOINT="https://otlp-gateway-<region>.grafana.net/otlp"
GRAFANA_CLOUD_BASIC_AUTH_HEADER="Basic <base64 instance:token>"
```

Resource attributes resolve from `REGIMEN_SERVICE_NAME`, `REGIMEN_SERVICE_VERSION`, and `REGIMEN_ENVIRONMENT`. `REGIMEN_DATA_DIR` overrides where the bridge looks for `feedback.db`.

### Running it as a service

`bun run start` is a foreground process that stops when its terminal closes. To keep the bridge streaming, run it under a process supervisor. On Linux and WSL a `systemd --user` service is the simplest, and matches how the Feedback loader runs.

Create `~/.config/systemd/user/regimen-otlp-bridge.service`, adjusting the paths to your `bun` and your `packages/otlp-bridge` directory:

```ini
[Unit]
Description=Regimen OTLP bridge
After=default.target

[Service]
Type=simple
ExecStart=/path/to/bun /path/to/regimen/packages/otlp-bridge/src/cli.ts
WorkingDirectory=/path/to/regimen/packages/otlp-bridge
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

`WorkingDirectory` must be the `packages/otlp-bridge` directory, so Bun loads the `.env` credentials from it. The unit does not redirect the daemon's output: the bridge writes its own `bridge.log` in the Regimen data directory and keeps it size-bounded itself (rolled at 1 MB, three copies kept). The daemon's stdout and stderr fall through to the systemd journal, which journald bounds. Then enable and manage the service:

```
systemctl --user daemon-reload
systemctl --user enable --now regimen-otlp-bridge   # install and start
systemctl --user status regimen-otlp-bridge         # health
systemctl --user restart regimen-otlp-bridge        # adopt updated code
systemctl --user stop regimen-otlp-bridge           # pause
tail -f ~/.local/share/regimen/bridge.log           # the operational log
journalctl --user -u regimen-otlp-bridge -f         # stdout and startup errors
```

The service runs `src/cli.ts` from the package working copy, and Bun loads the module code once at process start. A code change does not reach the running daemon until the service is restarted: after pulling new code, run `systemctl --user restart regimen-otlp-bridge`.

A cross-platform `bridge install-daemon` command, the equivalent of `feedback install-daemon`, is a planned follow-up; until then this unit is written by hand.

Once `bridge install-daemon` ships, the bridge will also compose into the unified install through the `@regimen/cli` orchestrator, as an optional step via `regimen install --with-bridge`. This is deferred until that command exists. The bridge reads `feedback.db` read-only (the ADR-0005 seam) and never has its Grafana secrets bundled, so the compose stays optional and the bridge keeps its own `.env`.

## How it stays correct

- **Per-stream watermarks.** Logs, metrics, and traces each advance an independent watermark, persisted to `<dataDir>/bridge/watermarks.json`. A crash or restart resumes from the last delivered position; a slow stream never pins another.
- **Each log and span emitted once.** Logs and the three trace span sources (session spans, tool spans, point events) each advance a boundary cursor, a timestamp plus the set of ids already emitted at it. An event landing at an already-passed millisecond is still delivered, and a span Grafana already has is never re-sent, so Tempo's per-trace size accounting is not inflated by repeats.
- **Idempotent metrics.** Metric counters are cumulative per session, so re-emitting a conversation on watermark overlap reports the same total rather than double-counting.
- **Bounded cardinality.** Resource attributes are bounded values only (`service.name`, `service.version`, `deployment.environment`). Per-event identifiers stay on the individual record or span.
- **Bounded operational log.** The bridge owns its `bridge.log` and rolls it at 1 MB, keeping three copies, so a daemon left running for months never leaks disk. Routine per-tick deliveries fold into a periodic heartbeat line; lifecycle events and delivery failures are logged as they happen, so the log stays a readable operational record.

## Development

```
bun install
bun run check      # typecheck + lint + format check + tests
```

Individual checks: `bun run typecheck`, `bun run lint`, `bun run format` (writes), `bun test`.

## Layout

| Path                     | What                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `src/source/`            | Reads the Feedback SQLite store; the only module that touches SQLite                          |
| `src/projection/`        | Pure shaping of source rows into OTLP logs, metrics, and traces                               |
| `src/state/`             | Per-stream watermark persistence                                                              |
| `src/exporter/`          | The delivery port: a live OTLP/HTTP adapter and a recording adapter for tests                 |
| `src/daemon.ts`          | The composition root: wires Source, Projection, State, Exporter, and the log into a poll loop |
| `src/cli.ts`             | CLI entry: builds the live daemon and handles shutdown                                        |
| `src/otlp.ts`            | OTLP/JSON message types and encoding helpers                                                  |
| `src/operational-log.ts` | The bridge's bounded `bridge.log`: heartbeat folding, plus a console variant for dry runs     |
| `src/rolling-log.ts`     | Size-based roll-and-retain that keeps `bridge.log` bounded                                    |
| `tests/`                 | Unit and integration tests, with a fixture mirroring the Feedback store schema                |
| `.env`                   | Grafana Cloud connection secrets. Gitignored, never committed                                 |
