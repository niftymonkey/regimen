# regimen-enforcement

The Regimen Enforcement instrument: discipline gates and the denial emitter.

A discipline gate is a harness PreToolUse hook that denies a tool call which violates a discipline (a recursive forced `rm`, an em dash in written content, an inline shell message body on a git/gh command). When a gate denies a call, it also records a `gate.denial` event so the evidence layer sees it.

## How denials are recorded

Enforcement is its own instrument and does not import any code from Feedback. Its denial emitter writes one JSON line across the published store-write seam: it resolves Feedback's data directory the documented way, builds a v1 `gate.denial` event with the frozen `trace_id` derivation, and appends the line to `<dataDir>/buffer/current.jsonl`. Feedback's loader drains that line into its store. The contract that governs this seam is `regimen-feedback/docs/store-write-contract.md`; the emitter (`hooks/emit-denial.ts`) and the line builder (`src/denial-store.ts`) reproduce it exactly so Enforcement's denials land in the same trace as the session's capture events.

bun is needed only to record a denial. If bun is absent, a shell gate still denies the call; only the telemetry is skipped.

## Gates

- `examples/rm-rf-gate.ts` (Claude) and `examples/rm-rf-gate-codex.ts` (Codex): deny a recursive forced `rm`.
- `examples/em-dash-gate.sh`: deny a Write/Edit whose content contains an em dash (U+2014). Needs `jq` to record.
- `examples/inline-message-guard.sh`: deny an inline shell message body on a git/gh message command. Needs `jq` to record.

## Install

Wire the gates into Codex's `~/.codex/hooks.json`:

```sh
./install.sh                       # wire all gates (bun install + install verb)
bun src/cli/index.ts wire-gates    # the gate-wiring step on its own
bun src/cli/index.ts wire-gates --gate rm-rf
bun src/cli/index.ts wire-gates --no-gates
bun src/cli/index.ts unwire-gates  # remove exactly Enforcement's gate entries
```

Flags: `--dry-run` previews every step and writes nothing, `--codex-home <path>` overrides the default `~/.codex`, `--gate <id>` is repeatable, `--no-gates` wires none. The installer is surgical: it never touches Feedback's capture hook or the user's own hooks.

## Develop

```sh
bun install
bun run check    # typecheck + lint + format:check + test
```
