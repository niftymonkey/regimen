# Codex Trial Readiness Plan

> The driver for getting Regimen usable during the upcoming app-first Codex harness trial. This document, not the project board, decides what gets worked on next for this push. Open it, find the first unchecked step, and execute it. The board remains the home for the individual issues; this plan decides the order they are picked up.

## Start here (for a fresh conversation)

Mission: make Regimen's three instruments usable while trialing Codex at work. The trial runs primarily in the Codex desktop app, the real phase begins around the week of 2026-06-09, and the trial machine is a Mac. Priorities, in order: the in-flow tight loop, post-hoc reflection, best-effort enforcement. The Grafana bridge is out of scope; the consumption path is the in-session agent reading Feedback from the local store.

Phase 0 (local validation) is done; its results are recorded below as verified facts, so they do not need re-deriving. Phase 1.1 to 1.4 are also done. 1.1 to 1.3 (the Codex capture hook and the hook translator) were live-validated 2026-06-02. 1.4 (the rollout tailer) was built and live-validated 2026-06-03 by replaying a real comprehensive `codex exec` session through it. The immediate next task is Phase 1.5: install the `feedback-evidence` skill into `CODEX_HOME/skills`. Hook-based capture stays the primary real-time path; the rollout tailer is the version-proof fallback and the judge-time transcript source.

Status (2026-06-02): the 1.2/1.3 code landed on `main` in `regimen-feedback` (loader-test deflake, the Codex capture feature, the removal of the repo-local hooks config). A CodeRabbit review came back clean (0 findings).

Status (2026-06-03): the 1.4 rollout tailer landed on `main` in `regimen-feedback`, and this plan's 1.4 update landed on `main` in the hub (both merged locally, not yet pushed to origin). `bun run check` is green (200 tests) and a CodeRabbit review of the tailer came back clean (0 findings). Two findings from replaying a real session corrected the build: per-file churn must be parsed from the `apply_patch` patch text (this build emits no `patch_apply_end`), and a web search is a `web_search_call` with no `call_id` (now mapped to a self-paired `web_search` tool span). Compaction mapping is unit-tested against the real 05/03 shape but has not fired in a live replay (it cannot be forced without filling the context window).

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

The Codex app runs on Windows with `runCodexInWindowsSubsystemForLinux = true` and `integratedTerminalShell = "wsl"`, so the agent and its shell commands execute inside WSL2 against WSL2 project directories. But its `config.toml` sets `CODEX_HOME = 'C:\Users\markd\.codex'` and a bundled Windows `codex.exe` as `CODEX_CLI_PATH`. So on this dev box there are two separate Codex homes: the app uses the Windows home `/mnt/c/Users/markd/.codex` (active), and a WSL2-native CLI uses `/home/mlo/.codex`. Correction (2026-06-02): the WSL2 home is NOT stale, contrary to the earlier "stale since May 3" reading; it is actively in use (`config.toml`, `logs_2.sqlite`, `history.jsonl`, and a same-day rollout all touched 2026-06-02), is authenticated (`auth.json`), and trusts the `regimen` hub project. The WSL2 CLI is `codex-cli 0.128.0` installed under nvm node v22.18.0, which is not the default node (v24.16.0), which is why `codex` is missing from a fresh shell's PATH; reach it directly at `~/.nvm/versions/node/v22.18.0/bin/codex` or via `nvm use 22.18.0`.

## Dev box versus trial machine (important)

The two-`CODEX_HOME` split (WSL2 home versus Windows home, and the resulting `/mnt/c` polling) is an artifact of running the app on Windows against WSL2. It is not how the trial machine behaves. On the Mac, the CLI and the app share one `~/.codex`, so the bundle's primary target is the single-home case: watch one `~/.codex/sessions` with native FS events, install the skill and any hook into one `~/.codex`, and run the daemon under launchd. The dual-home handling (hooks and skills in both homes, watching two `sessions/` dirs, polling `/mnt/c`) applies only to local validation on the dev box. Where Phase 1 names a `/mnt/c/.../.codex` path, read it as "the dev box's app home"; on the Mac it collapses to `~/.codex`.

## Hook firing validated (2026-06-02) and capture strategy

Live result from a probe placed in both homes: Codex hooks fire on the current build in both surfaces. The app (Windows home) fired `SessionStart` and `PreToolUse`; the WSL2 CLI fired `SessionStart`, `PreToolUse`, and `PostToolUse` (the last carrying the tool output). So openai/codex#21639 does not reproduce on this app build, and the earlier "hooks unreliable in the app" worry is superseded for this build: hooks are a viable capture and enforcement path here.

Revised capture strategy: hook-based capture is the primary real-time path, which mirrors Regimen's existing Claude design (a capture hook for structural events now, a transcript reader at judge time). The rollout-file tailer is the version-proof fallback for builds where app hooks regress (#21639 is open and was a real regression on other builds) and is the judge-time transcript source. Enforcement via `PreToolUse` is viable because it fires in both surfaces.

Version drift to keep in mind: the published Codex hooks docs track `main` and are ahead of the installed 0.128.0 CLI. On 0.128.0 the feature key is `codex_hooks` (stable, on by default); the newer `hooks` key is a rename and `codex_hooks` is the deprecated alias. 0.128.0 also has no hook-trust UI (`/hooks`) and no `--dangerously-bypass-hook-trust` flag, so configured user-level/inline hooks simply run once the project is trusted; the review-and-trust flow in the docs is a newer-build feature. Treat the docs as the behavior reference but verify config keys against `codex features list` on the actual build.

Caveat unrelated to hooks: on this Windows-plus-WSL dev box the app's own command execution is currently broken (`Failed to create unified exec process: No such file or directory`), so app tool calls fail after the `PreToolUse` hook has already fired. This is a Codex-app-on-Windows `unified_exec` issue, not a Regimen or hook problem (the same command and hooks ran cleanly in the WSL2 CLI), and it will not exist on the Mac. Its only local cost is that app `PostToolUse` could not be confirmed here and the app tool surface cannot be fully exercised on this box.

## Codex hook payload shape (validated)

Each hook command receives one JSON object on stdin. Observed fields:
- Common: `session_id`, `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, `permission_mode`.
- `SessionStart`: plus `source` (`startup`, `resume`, and so on).
- `PreToolUse`: plus `turn_id`, `tool_name` (for example `Bash`), `tool_input` (for example `{ "command": "..." }`), `tool_use_id`.
- `PostToolUse`: the `PreToolUse` fields plus `tool_response`.
- `UserPromptSubmit`: plus `turn_id` and `prompt`.
- `PreCompact`: plus `turn_id` and `trigger` (`manual` or `auto`).
- No `SessionEnd`: Codex has no session-end hook (its `Stop` and `SubagentStop` are turn-scoped, not session-scoped), so the translator never emits `session.end` from hooks; that boundary has to come from the rollout tailer (1.4).

Tool shape: a shell call arrives as `tool_name: "Bash"` with `tool_input.command`, and a file edit as `tool_name: "apply_patch"` with `tool_input.command` holding the patch text (there is no `tool_input.file_path` like Claude's `Edit`/`Write`), so per-file churn is not derivable from the hook payload and is left to the rollout reader.

The capture hook appends an envelope `{ harness: "codex", captured_at, payload }`; the translator maps the payload to v1. Tool spans pair by `tool_use_id`. This matches the Codex hooks docs and Regimen's existing Claude capture shape, so the Codex capture hook and translator are close ports of the Claude ones.

## Rollout JSONL format (validated, for the tailer and judge)

Transcripts are rollout JSONL at `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl`. Each line is `{ type, timestamp, payload }`.
- `session_meta` (first line): payload has `id` (session id), `cwd`, `cli_version`, `model_provider`, `originator`, `source`, `git`, `base_instructions`, `timestamp`.
- `turn_context`: payload has `model`, `cwd`, `approval_policy`, `sandbox_policy`, `effort`, `turn_id`.
- `event_msg` payloads (`payload.type`): `task_started`, `task_complete`, `user_message`, `agent_message`, `token_count`, `exec_command_end` (call_id, command, cwd, exit_code, duration, stdout/stderr, status: the shell result), `patch_apply_end` (the apply_patch result), `web_search_end`, `guardian_assessment`, `context_compacted`.
- `response_item` payloads: `function_call` (call_id, name, arguments), `function_call_output` (call_id, output), `custom_tool_call` and `custom_tool_call_output`, `message` (role, content), `reasoning`, `web_search_call`.
- `compacted` line: `replacement_history` (a compaction event).

Rollout tool spans pair by `call_id`: `function_call` is the pre, and `function_call_output` (or `exec_command_end` / `patch_apply_end` for the built-ins) is the post. The format is explicitly not a stable interface, so the rollout reader needs versioning. The `state_5.sqlite` `threads` table (`rollout_path`, `cwd`, `source`, `model`, `git_*`, `cli_version`, `tokens_used`) is a convenience index, not a contract; treat rollout files as the source of truth.

Build-variance findings (2026-06-03, from replaying a real 0.128.0 `codex exec` gpt-5.5 session, which the 1.4 reader is built and tested against): the taxonomy above is the union across builds, but a single build emits a subset. On this build there was no `patch_apply_end` and no `exec_command_end` at all; the shell result came only via `function_call_output` and the apply_patch result only via `custom_tool_call_output`. So the rollout reader cannot depend on `patch_apply_end` for per-file churn: it parses the touched files from the `apply_patch` patch text (the `*** Add/Update/Delete File:` headers in the tool call's `input`), which is present on every build. `apply_patch` arrives as a `custom_tool_call` (name `apply_patch`, patch in `input`), not a `function_call`. A web search is a `web_search_call` response item carrying `action.query` but no `call_id` and (on this build) no `web_search_end`; the reader maps it to a self-paired `web_search` tool span keyed by a per-session sequence. The native shell tool name in the rollout is `exec_command` (the hook surface reports `Bash`); the reader keeps native rollout tool names and leaves that hook-vs-rollout reconciliation to Phase 2.1 (#14).

## Where the code lives and what to reuse

- Regimen hub (this repo): `/home/mlo/dev/niftymonkey/regimen`. Holds `PRD.md`, `ARCHITECTURE.md`, `DOMAIN-LANGUAGE.md`, `docs/plan.md`, `docs/adr/`, and this plan under `plans/`.
- `regimen-feedback`: `/home/mlo/dev/niftymonkey/regimen-feedback` (Bun). The Feedback instrument; build Codex capture here. Verify paths on open, but as of 2026-06-02:
  - Capture hooks: `hooks/capture.ts` (Claude) and `hooks/capture-codex.ts` (Codex, done), both appending the `{ harness, captured_at, payload }` envelope to the buffer. Envelope type: `src/envelope.ts`.
  - Translator registry: `src/loader/translators/index.ts` (harness to translator map); the `codex` entry is registered.
  - Translators: `src/loader/translators/claude.ts` and `src/loader/translators/codex.ts` (done) beside it. v1 validation: `src/loader/translators/v1.ts`. Shared Codex v1 vocabulary that the hook translator and the rollout reader both emit through (so they cannot drift): `src/loader/translators/codex-events.ts`.
  - Rollout tailer (1.4, done): `src/loader/rollout/codex-reader.ts` (the pure `rolloutEvents(content, { complete })` fold) and `src/loader/rollout/tailer.ts` (`startRolloutTailer`, the polling shell with `pollOnce` and an opt-in `intervalMs`, injected sink). Tests: `tests/rollout-codex.test.ts`, `tests/rollout-tailer.test.ts`, `tests/smoke-rollout-codex.test.ts`.
  - Daemon and pipeline: `src/loader/{run,driver,drain}.ts`. Signal projections: `src/loader/projections.ts` (file-churn allowlist now includes `apply_patch`). Rotation: `src/loader/rotator.ts`.
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
- [x] 0.4 Rollout format and fixtures. Taxonomy captured above. Hook-envelope fixtures for translator TDD are done (`samples/codex-envelopes.jsonl`). Rollout fixtures for the tailer are done too: `samples/rollout-codex-session.jsonl` (a redacted real two-turn `codex exec` session: web search, shell, apply_patch) and `samples/rollout-shell-session.jsonl` (a minimal shell-only session). Real rollouts remain on disk under `~/.codex/sessions/YYYY/MM/DD/` if more shapes are ever needed.
- [x] 0.5 Hook firing (openai/codex#21639). Hooks fire in both the app (`SessionStart`, `PreToolUse`) and the CLI (`SessionStart`, `PreToolUse`, `PostToolUse` with `tool_response`). App `PostToolUse` unconfirmed only due to the separate `unified_exec` exec bug.
- [x] 0.6 In-app self session-id for the skill. The `SessionStart` hook carries `session_id`, `cwd`, and `transcript_path` in both surfaces, so a `SessionStart` hook can stamp the current session id per cwd for the skill. Zero-config fallback is most-recent-active (rollout mtime, or `state_5.threads.updated_at`). Open edge: two concurrent sessions in one cwd.
- [x] 0.7 Versions. WSL2 CLI `codex-cli 0.128.0` (node v22.18.0). App ran gpt-5.5 and gpt-5.4 on 2026-06-02, writing to `/mnt/c/Users/markd/.codex/sessions/2026/06/02/`; the WSL2 CLI writes to `/home/mlo/.codex/sessions/2026/06/02/`. App build number still worth recording from the About dialog.

## Phase 1: Backup-plan bundle (the floor), hooks-primary

Goal: a small, copy-and-run bundle that captures Codex sessions, surfaces them to the in-session agent, and applies one best-effort guardrail. Rough is acceptable; this code seeds Phase 2.

- [x] 1.1 Confirm the target environment. Dev box reconfirmed (2026-06-02): two homes still present (`~/.codex` and `/mnt/c/Users/markd/.codex`), shell `CODEX_HOME` unset. Mac single-home stays an open question for the real machine.
- [x] 1.2 Codex capture hook (producer). `hooks/capture-codex.ts`, a self-contained near-copy of `hooks/capture.ts` stamping `harness: "codex"` (the option-B file-per-harness decision). Built TDD (`tests/capture-codex.test.ts`): codex stamp, enabled-flag gate, capture-failure-never-surfaces. LIVE-validated 2026-06-02: an isolated `codex exec` run (temp `CODEX_HOME`, copied auth, inline `[hooks]` in `config.toml` with an absolute path to the hook) fired `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and wrote codex envelopes to the buffer; all dispatched through the translator with 0 quarantines. The shell tool reports `tool_name: "Bash"` with a `call_...` `tool_use_id` shared across the pre/post pair. The hooks CONFIG is intentionally NOT committed: a repo-local `.codex/hooks.json` was added, dogfood-validated, then removed because Codex loads all hook sources, so a user-level hook plus a trusted repo-local one make capture double-fire. Capture therefore wires via a user-level `~/.codex/hooks.json` (or inline `[hooks]` in `config.toml`) only: the five events `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PreCompact`, no matcher, no `statusMessage`, an ABSOLUTE path to `hooks/capture-codex.ts`. That config is part of 1.7's SETUP, so until 1.7 capture does not auto-fire from a fresh clone (dogfood it with a temp/user-level config as the 2026-06-02 validation did).
- [x] 1.3 Codex translator (consumer). `src/loader/translators/codex.ts` maps the five hook events to v1; registered `codex` in `index.ts`. Tool spans pair by `tool_use_id`. TDD (`tests/translator-codex.test.ts`) plus an end-to-end smoke through store + projections (`tests/smoke-codex.test.ts`, fixture `samples/codex-envelopes.jsonl`). Two honest divergences from Claude are baked in and tested: Codex has no `SessionEnd` hook so `session.end`/`session_ended_at` is never produced from hooks, and Codex edits go through `apply_patch` (`tool_input.command`) not an `Edit`/`Write` tool with `file_path`, so no per-file churn is derivable from the hook payload.
- [x] 1.4 Rollout-file tailer (fallback and judge transcript source). Built TDD. The deep, pure core is `src/loader/rollout/codex-reader.ts` (`rolloutEvents(content, { complete })`): a stateful fold over one rollout transcript to the same v1 vocabulary the hook translator emits (a per-line translator was impossible because a rollout `function_call` line carries no `session_id`; only `session_meta`/`turn_context` do, so session id and model are threaded across the fold). Tool spans pair by `call_id`, not `tool_use_id`. `src/loader/rollout/tailer.ts` is the polling shell (`startRolloutTailer` with a tested `pollOnce` and an opt-in `intervalMs`; injected sink so it is tested with an array and the daemon wires it to `store.insertEvent`); newest rollout is read open, every older rollout complete, which is where `session.end` comes from (stamped at the transcript's last timestamp, never force-closing the live session, reconciling ADR-0006's "never impute an end" with the 1.4 mandate). The shared v1 vocabulary was extracted to `src/loader/translators/codex-events.ts` so the hook translator and the rollout reader cannot drift. `apply_patch` was added to the file-churn projection allowlist. Tests: `tests/rollout-codex.test.ts` (unit, the fold and the patch-path extractor and web-search mapping), `tests/rollout-tailer.test.ts` (the completeness rule and the interval), `tests/smoke-rollout-codex.test.ts` (end to end through store + projections against a redacted real session). LIVE-validated 2026-06-03: a real two-turn `codex exec` session (web search x2, shell x2, apply_patch x3) replayed through the reader to exactly the expected events. Two findings from that replay corrected the build (per-file churn parses the patch text since this build has no `patch_apply_end`; a web search has no `call_id`) and are recorded in the "Rollout JSONL format" section. Honest gap: compaction mapping is unit-tested against the real 05/03 shape but has not fired in a live replay. Lower priority than hooks; also serves judge-time transcript reading (issue #14).
- [ ] 1.5 Install the `feedback-evidence` skill into `CODEX_HOME/skills`, wired with the 0.6 session-id approach. The skill runs in the agent's shell (WSL2 on the dev box, native on the Mac) and reads the local store.
- [ ] 1.6 Port one best-effort `PreToolUse` gate from `examples/rm-rf-gate.ts`, emitting denials via `hooks/emit-denial.ts` into the pipeline. Document the honest reliability: `PreToolUse` does not intercept every `unified_exec` shell path, so it is a guardrail, not a hard boundary. Doc-confirmed (2026-06-02): Codex's deny shape is identical to Claude's (`hookSpecificOutput.permissionDecision: "deny"` plus the legacy `{decision:"block"}` / exit-2 forms), so the gate body is a near-trivial port; Codex also exposes a dedicated `PermissionRequest` hook (`decision.behavior: "allow" | "deny"`), a stronger enforcement surface than `PreToolUse`, worth considering for 2.4.
- [ ] 1.7 Write `SETUP.md` and package the bundle: `regimen-feedback` (with the Codex capture hook, translator, and tailer), the evidence skill, the gate. Setup on the Mac: `bun install`, install the capture hook into `~/.codex`, `feedback start`, `feedback install-daemon` (launchd), drop the skill into `~/.codex/skills`. Doc-confirmed install steps: the user-level trial config is `~/.codex/hooks.json` with an ABSOLUTE path to the cloned `hooks/capture-codex.ts` (the repo-local `.codex/hooks.json`'s git-root trick only resolves when Codex runs inside regimen-feedback, not in the user's work repos), and Codex requires trusting the non-managed hook via `/hooks` (or a one-off `--dangerously-bypass-hook-trust`) before it runs. `bun` must be on the hook execution PATH (WSL2 shell on the dev box, native on the Mac).

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
