# Codex Trial Readiness Plan

> The driver for getting Regimen usable during the upcoming app-first Codex harness trial. This document, not the project board, decides what gets worked on next for this push. Open it, find the first unchecked step, and execute it. The board remains the home for the individual issues; this plan decides the order they are picked up.

## Start here (for a fresh conversation)

Mission: make Regimen's three instruments usable while trialing Codex at work. The trial runs primarily in the Codex desktop app, the real phase begins around the week of 2026-06-09, and the trial machine is a Mac. Priorities, in order: the in-flow tight loop, post-hoc reflection, best-effort enforcement. The Grafana bridge is out of scope; the consumption path is the in-session agent reading Feedback from the local store.

Phase 0 (local validation) is done; its results are recorded below as verified facts, so they do not need re-deriving. The immediate next task is Phase 1: build Codex capture in the `regimen-feedback` repo. Hook-based capture is the primary path (validated firing in both the app and the CLI on current builds), with a rollout-file tailer as the fallback. Build the producer (the capture hook) before the consumer (the translator).

Conventions to follow (most are also in the auto-loaded project memory):
- Use the `tdd` skill for any testable code: real red-green-refactor, and stub the unit under test first so red comes from the implementation, not a missing import.
- Producer before consumer: verify the capture hook's envelope output before building the translator that reads it.
- Harness-agnostic by default: schemas, event names, and interfaces must hold for any CLI and any model; harness-specifics live only at the capture/adapter edge and are normalized immediately.
- `regimen-feedback` is a Bun project: `bun test` runs the suite, `bun run check` runs typecheck, lint, and format.
- No em dashes anywhere.

Note: the hook probe used to validate Phase 0 has been removed (both `hooks.json` files, the probe script, the log, and the temporary `[features]` flags). Ignore any stray reference to `~/.regimen-probe` or `regimen-hook-probe.log`.

## Trial context

- Trial machine: a Mac, corporate but install-permitted (Bun installs and a user-level background daemon are allowed). On macOS the Codex CLI and the Codex app share one `~/.codex`, so there is a single sessions dir, a single skills dir, one config, and native filesystem events.
- Local dev machine (where Phase 0 was validated): Codex CLI in WSL2 and the Codex app on Windows, which is a different and messier topology (see below). It is for validating mechanics only.
- Priorities: in-flow tight loop, post-hoc reflection, best-effort enforcement guardrails.
- Out of scope: the OTLP/Grafana bridge.

## Verified machine topology of the dev box (2026-06-02, from on-disk forensics)

The Codex app runs on Windows with `runCodexInWindowsSubsystemForLinux = true` and `integratedTerminalShell = "wsl"`, so the agent and its shell commands execute inside WSL2 against WSL2 project directories. But its `config.toml` sets `CODEX_HOME = 'C:\Users\markd\.codex'` and a bundled Windows `codex.exe` as `CODEX_CLI_PATH`. So on this dev box there are two separate Codex homes: the app uses the Windows home `/mnt/c/Users/markd/.codex` (active), and a WSL2-native CLI uses `/home/mlo/.codex` (stale since May 3). The WSL2 CLI is `codex-cli 0.128.0` installed under nvm node v22.18.0, which is not the default node (v24.16.0), which is why `codex` is missing from a fresh shell's PATH; reach it with `nvm use 22.18.0`.

## Dev box versus trial machine (important)

The two-`CODEX_HOME` split (WSL2 home versus Windows home, and the resulting `/mnt/c` polling) is an artifact of running the app on Windows against WSL2. It is not how the trial machine behaves. On the Mac, the CLI and the app share one `~/.codex`, so the bundle's primary target is the single-home case: watch one `~/.codex/sessions` with native FS events, install the skill and any hook into one `~/.codex`, and run the daemon under launchd. The dual-home handling (hooks and skills in both homes, watching two `sessions/` dirs, polling `/mnt/c`) applies only to local validation on the dev box. Where Phase 1 names a `/mnt/c/.../.codex` path, read it as "the dev box's app home"; on the Mac it collapses to `~/.codex`.

## Hook firing validated (2026-06-02) and capture strategy

Live result from a probe placed in both homes: Codex hooks fire on the current build in both surfaces. The app (Windows home) fired `SessionStart` and `PreToolUse`; the WSL2 CLI fired `SessionStart`, `PreToolUse`, and `PostToolUse` (the last carrying the tool output). So openai/codex#21639 does not reproduce on this app build, and the earlier "hooks unreliable in the app" worry is superseded for this build: hooks are a viable capture and enforcement path here.

Revised capture strategy: hook-based capture is the primary real-time path, which mirrors Regimen's existing Claude design (a capture hook for structural events now, a transcript reader at judge time). The rollout-file tailer is the version-proof fallback for builds where app hooks regress (#21639 is open and was a real regression on other builds) and is the judge-time transcript source. Enforcement via `PreToolUse` is viable because it fires in both surfaces.

Caveat unrelated to hooks: on this Windows-plus-WSL dev box the app's own command execution is currently broken (`Failed to create unified exec process: No such file or directory`), so app tool calls fail after the `PreToolUse` hook has already fired. This is a Codex-app-on-Windows `unified_exec` issue, not a Regimen or hook problem (the same command and hooks ran cleanly in the WSL2 CLI), and it will not exist on the Mac. Its only local cost is that app `PostToolUse` could not be confirmed here and the app tool surface cannot be fully exercised on this box.

## Codex hook payload shape (validated)

Each hook command receives one JSON object on stdin. Observed fields:
- Common: `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, `permission_mode`.
- `SessionStart`: plus `source` (`startup`, `resume`, and so on).
- `PreToolUse`: plus `turn_id`, `tool_name` (for example `Bash`), `tool_input` (for example `{ "command": "..." }`), `tool_use_id`.
- `PostToolUse`: the `PreToolUse` fields plus `tool_response`.

The capture hook appends an envelope `{ harness: "codex", captured_at, payload }`; the translator maps the payload to v1. Tool spans pair by `tool_use_id`. This matches the Codex hooks docs and Regimen's existing Claude capture shape, so the Codex capture hook and translator are close ports of the Claude ones.

## Rollout JSONL format (validated, for the tailer and judge)

Transcripts are rollout JSONL at `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl`. Each line is `{ type, timestamp, payload }`.
- `session_meta` (first line): payload has `id` (session id), `cwd`, `cli_version`, `model_provider`, `originator`, `source`, `git`, `base_instructions`, `timestamp`.
- `turn_context`: payload has `model`, `cwd`, `approval_policy`, `sandbox_policy`, `effort`, `turn_id`.
- `event_msg` payloads (`payload.type`): `task_started`, `task_complete`, `user_message`, `agent_message`, `token_count`, `exec_command_end` (call_id, command, cwd, exit_code, duration, stdout/stderr, status: the shell result), `patch_apply_end` (the apply_patch result), `web_search_end`, `guardian_assessment`, `context_compacted`.
- `response_item` payloads: `function_call` (call_id, name, arguments), `function_call_output` (call_id, output), `custom_tool_call` and `custom_tool_call_output`, `message` (role, content), `reasoning`, `web_search_call`.
- `compacted` line: `replacement_history` (a compaction event).

Rollout tool spans pair by `call_id`: `function_call` is the pre, and `function_call_output` (or `exec_command_end` / `patch_apply_end` for the built-ins) is the post. The format is explicitly not a stable interface, so the rollout reader needs versioning. The `state_5.sqlite` `threads` table (`rollout_path`, `cwd`, `source`, `model`, `git_*`, `cli_version`, `tokens_used`) is a convenience index, not a contract; treat rollout files as the source of truth.

## Where the code lives and what to reuse

- Regimen hub (this repo): `/home/mlo/dev/niftymonkey/regimen`. Holds `PRD.md`, `ARCHITECTURE.md`, `DOMAIN-LANGUAGE.md`, `docs/plan.md`, `docs/adr/`, and this plan under `plans/`.
- `regimen-feedback`: `/home/mlo/dev/niftymonkey/regimen-feedback` (Bun). The Feedback instrument; build Codex capture here. Verify paths on open, but as of 2026-06-02:
  - Capture hook to mirror: `hooks/capture.ts` (appends the `{ harness, captured_at, payload }` envelope to the buffer). Envelope type: `src/envelope.ts`.
  - Translator registry: `src/loader/translators/index.ts` (harness to translator map). Add a `codex` entry.
  - Reference translator: `src/loader/translators/claude.ts`. Write `src/loader/translators/codex.ts` beside it. v1 validation: `src/loader/translators/v1.ts`.
  - Daemon and pipeline: `src/loader/{run,driver,drain}.ts`. Signal projections: `src/loader/projections.ts`. Rotation: `src/loader/rotator.ts`.
  - Store and schema: `src/store.ts`. v1 schemas: `schemas/`. Sample data: `samples/`.
  - Evidence read side: `src/evidence.ts`. CLI: `src/cli/index.ts` (`feedback evidence --session <id>`), install helpers: `src/cli/install/`.
  - Gate example to port: `examples/rm-rf-gate.ts`. Denial emitter into the pipeline: `hooks/emit-denial.ts`.
  - Tests: `tests/`, run with `bun test`. Buffer and SQLite store live under `~/.regimen/`.
- `skills`: `/home/mlo/dev/niftymonkey/skills` (Guidance). The `feedback-evidence` skill exists in the author's incubator; install it into the Codex `CODEX_HOME/skills` dir.

## What already exists (reuse, do not rebuild)

Everything downstream of the capture edge is already built and harness-agnostic: the daemon, the SQLite store, the five signal-projection tables, the evidence read side, the in-session `feedback-evidence` skill, cross-platform `install-daemon`, lifecycle and `purge`, and a worked `rm-rf` gate example with a denial emitter. The capture edge is the only Claude-specific seam, and that is what Phase 1 replaces for Codex. Feedback's evidence layer (program Phase 1.1 through 1.4) is effectively done; treat it as a dependency, not as work.

## Phase 0: Local groundwork and validation (done)

- [x] 0.1 CLI write path. Historical `cli`-source threads wrote rollouts to `CODEX_HOME/sessions/`. The WSL2 CLI is real (codex-cli 0.128.0 under node v22.18.0) but off the default-node PATH.
- [x] 0.2 Where the app writes. `CODEX_HOME = C:\Users\markd\.codex`; active rollouts at `/mnt/c/Users/markd/.codex/sessions/`. The app writes to Windows even though it executes in WSL2.
- [x] 0.3 Watch strategy. Poll `/mnt/c` on the dev box (DrvFs has no reliable inotify). On the Mac, native FS events on the single `~/.codex/sessions`.
- [x] 0.4 Rollout format and fixtures. Taxonomy captured above. Action remaining: save a couple of redacted rollout fixtures (one from a current app build) into the build repo for translator TDD.
- [x] 0.5 Hook firing (openai/codex#21639). Hooks fire in both the app (`SessionStart`, `PreToolUse`) and the CLI (`SessionStart`, `PreToolUse`, `PostToolUse` with `tool_response`). App `PostToolUse` unconfirmed only due to the separate `unified_exec` exec bug.
- [x] 0.6 In-app self session-id for the skill. The `SessionStart` hook carries `session_id`, `cwd`, and `transcript_path` in both surfaces, so a `SessionStart` hook can stamp the current session id per cwd for the skill. Zero-config fallback is most-recent-active (rollout mtime, or `state_5.threads.updated_at`). Open edge: two concurrent sessions in one cwd.
- [x] 0.7 Versions. WSL2 CLI `codex-cli 0.128.0` (node v22.18.0). App ran gpt-5.5 and gpt-5.4 on 2026-06-02, writing to `/mnt/c/Users/markd/.codex/sessions/2026/06/02/`; the WSL2 CLI writes to `/home/mlo/.codex/sessions/2026/06/02/`. App build number still worth recording from the About dialog.

## Phase 1: Backup-plan bundle (the floor), hooks-primary

Goal: a small, copy-and-run bundle that captures Codex sessions, surfaces them to the in-session agent, and applies one best-effort guardrail. Rough is acceptable; this code seeds Phase 2.

- [ ] 1.1 Confirm the target environment. On the Mac: one `~/.codex` shared by CLI and app, native FS watch, launchd. On the dev box: two homes, poll `/mnt/c`. Reconfirm `CODEX_HOME`.
- [ ] 1.2 Codex capture hook (producer, build and verify first). A `hooks.json` (or inline `[hooks]` in `config.toml`) in `CODEX_HOME` that runs a capture command appending the `{ harness: "codex", captured_at, payload }` envelope to the buffer, mirroring `hooks/capture.ts`. Wire `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`. Use the validated hook payload shape.
- [ ] 1.3 Codex translator (consumer). `src/loader/translators/codex.ts` mapping the Codex hook payloads to v1 events; register `codex` in `src/loader/translators/index.ts`. Pair tool spans by `tool_use_id`. TDD with fixtures from real sessions.
- [ ] 1.4 Rollout-file tailer (fallback and judge transcript source). Polling reader of `CODEX_HOME/sessions/**/*.jsonl` per the rollout taxonomy. Lower priority than hooks; also serves judge-time transcript reading (issue #14).
- [ ] 1.5 Install the `feedback-evidence` skill into `CODEX_HOME/skills`, wired with the 0.6 session-id approach. The skill runs in the agent's shell (WSL2 on the dev box, native on the Mac) and reads the local store.
- [ ] 1.6 Port one best-effort `PreToolUse` gate from `examples/rm-rf-gate.ts`, emitting denials via `hooks/emit-denial.ts` into the pipeline. Document the honest reliability: `PreToolUse` does not intercept every `unified_exec` shell path, so it is a guardrail, not a hard boundary.
- [ ] 1.7 Write `SETUP.md` and package the bundle: `regimen-feedback` (with the Codex capture hook, translator, and tailer), the evidence skill, the gate. Setup on the Mac: `bun install`, install the capture hook into `~/.codex`, `feedback start`, `feedback install-daemon` (launchd), drop the skill into `~/.codex/skills`.

Exit criterion: on a fresh install-permitted machine, a Codex session (app or CLI) is captured and the in-session agent can read its own session signals back from the store, and a gate denies a risky action.

## Phase 2: Harden and extend, in ticket order

- [ ] 2.1 Tailer and reader done right: per-harness transcript reader plus rollout-format versioning. Issue #14. Reuses the built evidence layer (#3). Populate per-conversation cwd from `session_meta.cwd` (#26).
- [ ] 2.2 Promote hook capture to the proper, tested Codex capture path across surfaces, with the full translator. Program plan Phase 1.5 (second harness).
- [ ] 2.3 Publish the skills, including the evidence skill, with a Codex adoption path. Issue #2.
- [ ] 2.4 Enforcement done right: design (#6), then a real reference gate (#7), denials flowing into Feedback, with honest cross-surface reliability notes.
- [ ] 2.5 Build `feedback list` and `feedback show` for human post-hoc reflection. Issue #15. Stretch; partly redundant if the in-session skill read is enough.
- [ ] 2.6 Judgment layer for a real "did this harness serve me" verdict: assess (#21), assignment intent and outcome (#22), cross-conversation rollups (#23), pattern surfacing (#24), in-session judge skill (#25), under epic #4. Out of scope for the one-week window; pick up after the real phase starts if time allows.

## Open questions

- Whether the Mac trial machine matches expectations (single `~/.codex` shared by CLI and app, native watch). Phase 0 validated the WSL dev box, not the Mac; reconfirm in Phase 1.1.
- Which single gate gives the most signal for the least risk as the Phase 1 guardrail.
- Translator and rollout-reader versioning approach, given the rollout format is not a stable interface.
- The concurrency edge for in-app session-id (two sessions sharing one cwd).
- Not being chased: the dev box's app `unified_exec` exec bug. Orthogonal to Regimen and absent on the Mac.

## Pointers

- PRD trial framing: `PRD.md` (Problem Statement; the "Evaluating a new harness or model" stories; the note that the workplace harness trial is the forcing function for Phases 1 and 2).
- Program plan: `docs/plan.md`. Domain language: `DOMAIN-LANGUAGE.md`.
- Loader and capture architecture: `docs/adr/0005-feedback-data-architecture.md`, `docs/adr/0006-feedback-loader-architecture.md`.
- Issues in play: #14, #3, #26, #2, #6, #7, #15, #21, #22, #23, #24, #25, #4.
- External (Codex), as of 2026-06-02: https://developers.openai.com/codex/hooks , https://developers.openai.com/codex/app/features , https://developers.openai.com/codex/app-server ; openai/codex issues #21639, #18090, #21753, #20864, #24197.
