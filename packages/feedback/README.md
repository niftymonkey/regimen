# @regimen/feedback

The Feedback instrument of the **Regimen** monorepo: a local, harness-agnostic system for observing AI coding sessions and judging how the work went. This is the `packages/feedback` workspace package. The data architecture is settled in [ADR-0005](../../docs/adr/0005-feedback-data-architecture.md).

At the capture edge, a per-harness hook appends each event to a JSONL buffer. A loader drains that buffer into a local SQLite store, normalizing each event to the [event schema](docs/event-schema.md) and computing deterministic signals as it goes. A Feedback CLI reads SQLite for display and orchestrates judging when asked, reaching out to a per-harness transcript reader for the conversation content and to an LLM for the judgment. Conversation content itself is never duplicated: the harness's own transcript file is the canonical record.

This is a TypeScript project; the hooks and tooling run on [Bun](https://bun.sh).

To stand up the Feedback instrument (capture, daemon, and the bundled Guidance skills) in one command, run `./install.sh` from the monorepo root; see [`SETUP.md`](SETUP.md) for what it wires, the flags, and how to verify and uninstall. The Enforcement pillar (the discipline gates and the denial emitter) is the sibling [`packages/enforcement`](../enforcement) package, installed from there; it wires its gate leaves into the same `~/.codex/hooks.json` without disturbing Feedback's capture hook.

## Status

The capture edge is in place: a Claude Code hook appends each session event as a JSON line to a daily JSONL buffer in `~/.regimen/`. The downstream pieces (the loader, the SQLite store, the CLI, and the per-harness transcript readers used at judge time) are next.

## The capture hook

`hooks/capture.ts` is a Claude Code hook, run with Bun. On each session event, it reads the harness's hook payload from stdin and appends one JSON line to today's buffer file. The hook exits 0 unconditionally and writes nothing to stdout, so a capture failure can never block or interfere with the session.

- **Events captured:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, mapped to the five session and tool event types; the model is recorded when the payload exposes it.
- **Buffer:** a directory of daily JSONL segments; see [The buffer](#the-buffer) below.
- **`trace_id`** is derived deterministically from `session_id`, so every event of a session shares one trace id. `tool.pre` and `tool.post` carry a shared `tool_call_id`, so downstream readers pair them into spans with no hook state.
- **Registration:** `.claude/settings.json` in this package wires the hook to all five events. Open a Claude Code session in this package, approving the project hooks when prompted, and the buffer fills as you work.
- **Errors**, if any, go to `~/.regimen/capture-errors.log` and are never surfaced to the session.

## The buffer

The capture hook and any external producer writing across the [store-write contract](docs/store-write-contract.md) append to the same buffer: a directory holding `current.jsonl` (the active segment) plus zero or more `sealed-<rfc3339>.jsonl` segments the loader daemon rotated out. The default per-OS data dir is XDG `~/.local/share/regimen` on Linux and WSL, `~/Library/Application Support/regimen` on macOS, and `%APPDATA%\regimen` on Windows, with the buffer under `<dataDir>/buffer`. Override the whole data dir with `REGIMEN_DATA_DIR`.

- **The buffer is plumbing**, not a layer downstream tools read. The loader daemon drains it into SQLite, and the events table is what every consumer (CLI, OTLP bridge, future skills) reads.
- **Multiple conversations share one buffer.** Every active harness session on the machine appends its envelopes into the same `current.jsonl` from its own subprocess. Append atomicity comes from the regular file itself: on Linux and macOS, `open(O_APPEND)` plus `write()` of one line is kernel-atomic for writes up to `PIPE_BUF`; on native Windows, opening with `FILE_APPEND_DATA` (Node and Bun's append-mode default) gives the same property through the filesystem driver. Concurrent hooks interleave at line granularity, never within a line, and no cross-process lock is needed.
- **The failure mode is one quarantined line.** If a write does straddle a kernel boundary (an envelope exceeds `PIPE_BUF` and the kernel commits the halves around another appender's write), the resulting line fails `JSON.parse` and the loader inserts one row into the `quarantine` table with the raw bytes and the reason. The events table is untouched, the loader continues past the bad line, and event-hash idempotency means a hook that retries on a partial write does not double-write. `tests/concurrent-producers.test.ts` fires 100 hook subprocesses across four sessions at one buffer and asserts zero quarantine and a correct per-session row count.

## Development

Bun is the runtime. Install dependencies, then run the checks:

```
bun install
bun run check      # typecheck + lint + format check + tests
```

Individual checks: `bun run typecheck`, `bun run lint`, `bun run format` (writes), `bun test`. Linting is ESLint with typescript-eslint; formatting is Prettier.

## Layout

| Path                                                | What                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `hooks/capture.ts`                                  | The Claude Code capture hook.                                           |
| `hooks/event-log.ts`                                | Shared core: event shape, trace-id derivation, daily-segmented append.  |
| `.claude/settings.json`                             | Registers the capture hook on five Claude session events.               |
| `tests/capture.test.ts`                             | Tests for the capture hook: schema validity, span pairing, integration. |
| `tests/event-schema.test.ts`                        | Tests for the schema against the sample.                                |
| `tests/event-log.test.ts`                           | Tests for buffer segmentation and reading across a rotation.            |
| `schemas/event.schema.json`                         | The event schema. Authoritative JSON Schema (Draft 2020-12).            |
| `docs/event-schema.md`                              | The event schema rationale.                                             |
| `samples/event.jsonl`                               | An eleven-event sample session that validates against the schema.       |
| `package.json`, `tsconfig.json`, `eslint.config.js` | TypeScript project and tooling configuration.                           |

## Earlier framings

Two earlier framings of this package are superseded by ADR-0005; noted so a later reader does not re-propose them.

- **A two-tier telemetry-and-evaluation layer projecting JSONL into OTel signals.** Earlier, this package framed itself as Tier 1 (telemetry: an append-only JSONL log projected on read into OTel logs, metrics, and traces) and Tier 2 (evaluation: an LLM that reads the telemetry). ADR-0005 supersedes this with a single store (SQLite) and a CLI that owns judging; OTLP output is a separate optional renderer (the sibling [`packages/otlp-bridge`](../otlp-bridge) package) that reads SQLite.
- **A versioned line of event schemas (v0 then v1).** An earlier tracer-bullet phase introduced a minimal v0 schema, later evolved to a fuller v1. The current schema is now the schema; `schema_version` is retained for future migration, but the line is not framed as evolving versions. See `docs/event-schema.md` for the full earlier-approaches note.
