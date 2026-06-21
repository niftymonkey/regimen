# The harness descriptor contract

Regimen supports several agent CLIs, and two instruments (Feedback and Enforcement) both need to know harness-specific facts: where a harness keeps its config home, where its hooks file lives and in what format, and where its skills install. Both instruments also WRITE into the same single hooks file (Feedback's capture leaves, Enforcement's gate leaves), so they must agree on its path and shape or they corrupt each other's config. This document is that shared agreement.

It also draws the line between what is shared and what is private, because getting that line wrong is what makes a multi-instrument, multi-harness system rot.

## Data is shared; behavior is private

A harness's support splits into two halves with different ownership.

**The contract (shared DATA).** The cross-instrument subset is pure data and lives in `packages/shared/src/harness/contract.ts` as `HarnessContract`. Both instruments import it; since the monorepo consolidation (ADR-0010) there is one copy, not a hand-synced duplicate per repo. Its shape:

| Field | Meaning |
| --- | --- |
| `harness` | The normalized lowercase identifier (the shared `Harness` type). |
| `configHome` | `{ envVar, defaultSubdir }`: the env var that overrides the config home (e.g. `CODEX_HOME`) and the default subdir of `$HOME` (e.g. `.codex`). |
| `hooksFile` | `{ relativePath, format }`: where the hooks file sits relative to the config home, and its on-disk structural format. |
| `skillsSubdir` | Where skills install, relative to the config home (`<configHome>/<skillsSubdir>/<name>/SKILL.md`). |

`hooksFile.format` is one of two structural shapes (the `HooksFormat` union):

- `nested-matcher-groups`: Claude's `settings.json`, Codex's `hooks.json`, Gemini's `settings.json`. An event maps to matcher-groups, each group holding a command-leaf array.
- `versioned-command-leaves`: Copilot's `hooks/hooks.json`. A `{ version, hooks: { <event>: [ flat-leaf ] } }` envelope, each leaf a flat command object, no matcher-group wrapper.

The install planner branches on `format` to emit the right shape (the capture-hooks planner handles both as of the Copilot bring-up). The per-harness concrete values, and the messier behavioral edge facts the contract does not capture (hook-event names, payload shapes, headless trust quirks), live in `harness-divergences.md`.

**The descriptor and ports (Feedback-private).** Feedback needs more per-harness data than the shared contract: the capture events to subscribe, the producer script the hook command invokes, and the sentinel leaf marker. That is the `HarnessDescriptor` in `packages/feedback/src/harness/descriptor.ts`, which references the shared contract rather than restating it. Feedback also needs per-harness BEHAVIOR: a `TranscriptReader` (read a transcript into v1 events) and a `SessionResolver` (find the current session and locate its transcript). Those are the ports in `packages/feedback/src/harness/ports.ts`, with one adapter per harness. Behavior is private and is NOT in the contract on purpose: function references cannot be frozen as shared data, and only Feedback reads transcripts. The `harnessSupport(harness)` registry composes descriptor + reader + resolver.

## Harness resolution

Which harness a command is acting for is resolved from the environment, never a flag (vendor-agnostic, env-driven config). `resolveHarnessFromEnvironment` in `@regimen/shared` resolves it: an explicit `REGIMEN_HARNESS` wins (validated, throws on an unknown value), else the first present CLI-set env marker from `HARNESS_ENV_MARKERS` (`CLAUDECODE` for Claude, `CODEX_THREAD_ID` for Codex, `GEMINI_CLI` for Gemini, `COPILOT_CLI` for Copilot), else it fails closed. Detection keys off CLI-set markers, not provider keys (an ambient `ANTHROPIC_API_KEY` is present inside other harnesses too), and not process ancestry (Codex sandboxes its shell in a separate PID namespace, so ancestry fails for it). Enforcement does not detect: its gates have `REGIMEN_HARNESS` baked into the gate command at install time, so they always know their harness explicitly.

## Why a written contract at all

Both instruments write leaves into one shared hooks file, recognized by a `_regimen` marker (`role: "capture"` for Feedback, `role: "gate"` for Enforcement), each preserving the other's leaves. If the two instruments disagreed on the file path or format, install would clobber. This contract is the program-level analog of `store-write-contract.md`: where that one lets an external producer write the store safely, this one lets two instruments write one harness's config safely. The shared data living in `@regimen/shared` is the enforcement of the agreement; this document is its rationale and reference.
