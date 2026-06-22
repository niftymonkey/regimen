# Harness divergences

Regimen is harness- and model-agnostic by design: every schema, signal, interface, and config holds for any agent CLI, and harness-specific detail is confined to a thin capture/adapter edge per harness. This document is the living reference for what lives at that edge: the concrete, producer-confirmed ways each supported harness differs. It is not a decision record (those are in `docs/adr/`) and not the high-level narrative (`ARCHITECTURE.md`); it is the empirical raw material both draw on, and the answer to "how was harness X different."

Every fact here is producer-confirmed from a real on-disk transcript or a real captured hook payload on a dev box, not inferred. Versions observed: Claude Code 2.1.185, codex-cli 0.141.0, GitHub Copilot CLI 1.0.63, Gemini CLI 0.47.0. When a fact is inferred rather than observed, it says so inline.

## Why the edge is not uniform

The design goal is that adding a harness is "one new capture hook file plus one new translator." That holds for the judge/read path. The live-capture install path is messier: each CLI has its own hooks-file format, its own hook-event taxonomy, its own hook-trust gate, and its own idea of what the hook receives on stdin. The matrix below is what that messiness actually looks like, so the next harness bring-up starts from fact instead of re-discovery.

## At-a-glance matrix

| Dimension | Claude | Codex | Copilot | Gemini |
| --- | --- | --- | --- | --- |
| Config-home env var | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `COPILOT_HOME` | `GEMINI_CONFIG_DIR` |
| Default config dir | `~/.claude` | `~/.codex` | `~/.copilot` | `~/.gemini` |
| Auth location | outside the config dir (works with an isolated config dir) | `CODEX_HOME/auth.json` (+ `config.toml`) | `~/.copilot/config.json` (+ `permissions-config.json`) | `~/.gemini/gemini-credentials.json` (+ `google_accounts.json`); api-key auth type |
| Hooks file (relative) | `settings.json` | `hooks.json` | `hooks/hooks.json` | `.gemini/settings.json` (project-level, see ADR-0011) |
| Hooks file format | nested-matcher-groups | nested-matcher-groups | versioned-command-leaves | nested-matcher-groups, but requires `name` + `matcher` per group |
| Hook event names | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact (no SessionEnd) | sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse (preCompact listed, not observed) | SessionStart, SessionEnd, BeforeAgent, BeforeTool, AfterTool, PreCompress |
| Event name in hook payload? | yes (`hook_event_name`) | yes (`hook_event_name`) | NO (inferred from field shape) | yes (`hook_event_name`) |
| Tool-call id in hook payload? | yes (`tool_use_id`) | yes | no (fallback to capture time) | no (fallback to capture time) |
| Payload timestamp | ISO string | ISO string | epoch milliseconds (number) | ISO string |
| Translator mapping style | name-based | name-based | shape-inferred | name-based |
| Session id exposed to shell env | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` | `COPILOT_AGENT_SESSION_ID` | none (filesystem resolver) |
| Transcript location | `CLAUDE_CONFIG_DIR/projects/<slug>/<id>.jsonl` | `CODEX_HOME/sessions/<date>/rollout-*.jsonl` | `COPILOT_HOME/session-state/<id>/events.jsonl` | `~/.gemini/tmp/<alias>/chats/session-*.jsonl` (ignores `GEMINI_CONFIG_DIR`) |
| Reasoning excluded from judge content | `thinking` blocks | reasoning items | encrypted `reasoningOpaque` / `encryptedContent` | `thoughts[]` |
| Headless launch flags (gate) | `-p --dangerously-skip-permissions` | `exec --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --skip-git-repo-check`, stdin closed | `-p --allow-all-tools`, user-level hooks only | `-p --yolo` + `GEMINI_CLI_TRUST_WORKSPACE=true` |

## Notable per-harness divergences

These are the edge facts worth a sentence in any high-level write-up, because they cost real discovery time or shape the adapter design.

### Claude

The reference harness; the rest are measured against it. Its hook payload is the template (`hook_event_name`, `session_id`, `tool_name`, `tool_input.file_path`, `tool_use_id`), and its auth lives outside the config dir, so an isolated `CLAUDE_CONFIG_DIR` still authenticates with no seeding. The transcript synthesizes session start/end from the first/last lines (no session-meta line).

### Codex

Two surprises gate live capture. First, freshly written hooks are untrusted and, in non-interactive `exec`, are silently skipped rather than prompted; `--dangerously-bypass-hook-trust` is required for them to fire in automation. Second, `codex exec` blocks on an open stdin, so stdin must be closed. Codex also runs its shell inside a `bwrap --unshare-pid` sandbox, which puts the `codex` process outside the visible `/proc` tree, so process-ancestry harness detection fails for Codex (env-marker detection on `CODEX_THREAD_ID` was chosen instead). Codex has turn-scoped stops, not a SessionEnd hook.

### Copilot

The cleanest transcript, but the loudest live-capture divergence: the hook stdin payload carries **no event name** (per GitHub docs, "scripts must be dedicated to specific hooks"). The translator therefore infers the event from the payload's field shape (`toolName` present, with `toolResult` discriminating post from pre; `initialPrompt`/`source` for start; `prompt`; `reason`). The payload timestamp is epoch milliseconds, not ISO, and there is no tool-call id. The hooks file is the `versioned-command-leaves` format (`{version, hooks: {event: [flat-leaf]}}`), each leaf supporting a per-leaf `env` block, and Copilot tolerates the extra `_regimen` marker key. Only **user-level** hooks at `$COPILOT_HOME/hooks/*.json` fire in headless `-p`; repository-level `.github/hooks` are not loaded in `-p`.

### Gemini

The most divergent install path: capture hooks install **project-level**, settled in ADR-0011. Gemini's hooks live in `settings.json` like Claude's, but each hook group must carry both a `name` and a `matcher` (the capture planner now emits both, commit `2bf06467a9`), and Gemini fingerprint-trusts hooks. A controlled probe settled the scope question: with everything else held constant, a **project-level** `.gemini/settings.json` fires headless while a user-level `GEMINI_CONFIG_DIR/settings.json` does not. The probe was disambiguated by a control, because the user-level run also hit the free-tier quota and crashed: the project-level recipe run under the identical exhausted quota still captured `SessionStart`/`BeforeAgent`/`SessionEnd`, proving those hooks fire before the model call and that the user-level empty buffer is a real negative, not a crash artifact. So Gemini's capture hooks install into the workspace's `.gemini/settings.json`, not the config home (the per-workspace ergonomic cost is the subject of ADR-0011). Gemini 0.47.0 **passes inherited environment vars** like `REGIMEN_DATA_DIR` through to the hook subprocess (confirmed 2026-06-21 by a controlled env-probe and an isolated live-fire that captured into the isolated data dir), so no wrapper is needed to isolate capture: the production `bun <clonePath>/hooks/capture-gemini.ts` command fires faithfully under an isolated `REGIMEN_DATA_DIR`. An earlier note that Gemini strips this var did not hold for 0.47.0; the wrapper in `e2e-gate.sh` is a leftover and not required for isolation. It writes its transcript to the real `~/.gemini/tmp`, ignoring `GEMINI_CONFIG_DIR`. The hook payload is otherwise Claude-like and maps by `hook_event_name`. Gemini is the only harness exposing no session id to the shell, so it uses a filesystem resolver. Headless runs require `GEMINI_CLI_TRUST_WORKSPACE=true` in a fresh directory.

## Where this feeds

- `ARCHITECTURE.md` "Constraints and boundaries" draws its harness-agnostic claim from this edge; the eventual high-level write-up summarizes this matrix rather than re-deriving it.
- New-harness bring-up follows the producer-first pattern: read a real transcript and capture real hook payloads before building the reader and translator, then add a row here.
- The live-capture install planner (`packages/feedback/src/cli/install/capture-hooks.ts`) branches on the hooks-file format column; the readers and translators key off the payload-shape columns.
