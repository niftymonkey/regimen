# @regimen/guidance

The Regimen Guidance instrument: the advisory response lever. This is the `packages/guidance` workspace package of the Regimen monorepo.

Guidance asks the model to behave differently when asking can plausibly work. It is the thinnest lever: its only artifact is an operator skill, `guidance-respond`, the act-beat helper that finds, builds, or reaches for the engineer's own advisory move on demand (a standing-instruction line, a context doc, a memory edit, a skill, a slash command, a subagent, a prompt template, a checklist, an MCP server, a CLI tool, a retrieval source, a routing / output-style / scoping choice). Regimen ships NO catalog of moves: a move is the engineer's own, found via `npx skills` or authored by the skill, not a maintained Regimen product. When the correction-cost history shows asking has already failed, the skill hands forward to the Enforcement side rather than authoring a weaker advisory move.

## What the package holds

- `skills/guidance-respond/SKILL.md`: the act-beat operator skill (the package's primary and only user-facing artifact), bundled into `regimen install`.
- `src/cli/index.ts`: the slim install facade. `install`/`uninstall` lay down and remove the operator skill through the shared bundler. There is no gate-wiring path and no emit: Guidance has no deterministic mechanism to wire, and validation is the judge reading the captured conversation.

## Install

The monorepo's root `./install.sh` composes this instrument through `regimen install`, which lays down the `guidance-respond` skill. There is nothing else to wire: an advisory move is the engineer's own, enacted on demand by the skill, not at install time.

## Develop

```sh
bun install
bun run check    # typecheck + lint + format:check + test
```
