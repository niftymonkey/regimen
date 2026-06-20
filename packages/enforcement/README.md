# @regimen/enforcement

The Regimen Enforcement instrument: discipline gates and the denial emitter. This is the `packages/enforcement` workspace package of the Regimen monorepo.

A discipline gate is a harness PreToolUse hook that denies a tool call which violates a discipline (a recursive forced `rm`, an em dash in written content, an inline shell message body on a git/gh command). When a gate denies a call, it also records a `gate.denial` event so the evidence layer sees it.

## How denials are recorded

Enforcement is its own instrument and does not import any code from Feedback. Its denial emitter writes one JSON line across the published store-write seam: it resolves Feedback's data directory the documented way, builds a v1 `gate.denial` event with the frozen `trace_id` derivation, and appends the line to `<dataDir>/buffer/current.jsonl`. Feedback's loader drains that line into its store. The contract that governs this seam is the feedback package's [`docs/store-write-contract.md`](../feedback/docs/store-write-contract.md); the emitter (`hooks/emit-denial.ts`) and the line builder (`src/denial-store.ts`) reproduce it exactly so Enforcement's denials land in the same trace as the session's capture events.

bun is needed only to record a denial. If bun is absent, a shell gate still denies the call; only the telemetry is skipped.

## Gates

- `examples/rm-rf-gate.ts`: deny a recursive forced `rm`. Harness-agnostic; it stamps the recorded harness from `REGIMEN_HARNESS` (defaulting to `claude`).
- `examples/em-dash-gate.sh`: deny a Write/Edit whose content contains an em dash (U+2014). Needs `jq` to record.
- `examples/inline-message-guard.sh`: deny an inline shell message body on a git/gh message command. Needs `jq` to record.

## Install

The monorepo's root `./install.sh` composes this instrument through `regimen install`. To run the gate-wiring step on its own from this package, set `REGIMEN_HARNESS` so it knows which harness to wire (it writes to that harness's hooks file, e.g. `~/.codex/hooks.json` for Codex; override the location with the harness's own config-home env var, e.g. `CODEX_HOME`):

```sh
REGIMEN_HARNESS=codex bun src/cli/index.ts wire-gates    # wire all gates
REGIMEN_HARNESS=codex bun src/cli/index.ts wire-gates --gate rm-rf
REGIMEN_HARNESS=codex bun src/cli/index.ts wire-gates --no-gates
REGIMEN_HARNESS=codex bun src/cli/index.ts unwire-gates  # remove exactly Enforcement's gate entries
```

Flags: `--dry-run` previews every step and writes nothing, `--gate <id>` is repeatable, `--no-gates` wires none. The harness and its config home travel in the environment, not in flags: Enforcement resolves the harness from `REGIMEN_HARNESS` and fails closed when it is unset. The installer is surgical: it never touches Feedback's capture hook or the user's own hooks.

## Develop

```sh
bun install
bun run check    # typecheck + lint + format:check + test
```
