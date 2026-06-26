# @regimen/enforcement

The Regimen Enforcement instrument: discipline gates. This is the `packages/enforcement` workspace package of the Regimen monorepo.

A discipline gate is a harness PreToolUse hook that denies a tool call which violates a discipline (a recursive forced `rm`, an em dash in written content, an inline shell message body on a git/gh command). The gate writes the deny decision back to the harness and stops there; a denial leaves an `is_error` tool-result in the harness transcript that Feedback already captures, so the LLM judge reads it from the conversation. The gate does not self-report the denial (see [ADR-0014](../../docs/adr/0014-enforcement-drops-the-gate-denial-emit-seam.md)).

## Gates

- `examples/rm-rf-gate.ts`: deny a recursive forced `rm`. Harness-agnostic.
- `examples/em-dash-gate.sh`: deny a Write/Edit whose content contains an em dash (U+2014). Needs `jq`.
- `examples/inline-message-guard.sh`: deny an inline shell message body on a git/gh message command. Needs `jq`.

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
