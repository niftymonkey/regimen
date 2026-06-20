# Feedback setup

One command stands up the Feedback instrument on a fresh machine: capture into the local store plus the daemon and the judgment layer, and the two bundled in-session skills that read it back (`feedback-evidence` and `feedback-judgment`). The bundle is just this package plus the bundled skills it ships. There is no separate artifact to download.

The Enforcement pillar (the discipline gates and the denial emitter) is the sibling [`packages/enforcement`](../enforcement) package, installed from there. Feedback wires only its capture hook; it never wires gates. The two installs coexist in the same `~/.codex/hooks.json`: Feedback preserves enforcement's gate leaves verbatim, and enforcement preserves Feedback's capture leaf, so the order of the two installs does not matter.

The Guidance pillar (the curated, multi-harness skills you bring to the agent, distinct from Feedback's two bundled in-session readers above) is also separate and is not wired by `regimen install`. Install it from [`niftymonkey/skills`](https://github.com/niftymonkey/skills) with the [`skills`](https://github.com/vercel-labs/skills) CLI (run via `npx`, or `bunx`): `npx skills@latest add niftymonkey/skills -g -a codex -s '*' -y`. The CLI auto-detects the running agent, so `-a codex` pins the target to Codex and `-s '*' -y` installs the full set without prompts; confirm they landed with `ls ~/.codex/skills`. Skills you use directly from upstream (for example [`mattpocock/skills`](https://github.com/mattpocock/skills)) install the same way; the niftymonkey set already vendors the MIT-adapted Pocock companions it builds on, so there is no separate dependency step for those.

## Scope

This guide targets the trial machine: a Mac where the Codex CLI and the Codex app share one `~/.codex` (one sessions directory, one skills directory, one config). Where your topology differs (for example a Windows app driving a WSL2 CLI, which uses two separate Codex homes), point the harness's own config-home environment variable at each home and run the install once per home, or use the manual fallback at the end. The mechanics are the same; only the paths multiply.

## Prerequisites

- [Bun](https://bun.sh) installed and on your PATH. The capture hook runs as `bun <script>`, so `bun` must be resolvable in the shell Codex uses to run hooks, not only in your interactive shell.
- A Codex build with hooks enabled. Confirm with `codex features list` that the hooks feature is on (it is `codex_hooks`, on by default on 0.128.0; newer builds rename it to `hooks`).
- `ANTHROPIC_API_KEY` exported in your shell, for the `feedback-judgment` skill (it makes a live model call). Capture and evidence work without it; only the judged verdict needs it.
- The monorepo cloned to a stable absolute path. The hooks are wired by absolute path; if you move the clone, re-run `feedback wire-hooks` (it re-homes the commands in place).

## Install

The one-command front door is the monorepo's root installer, not Feedback directly. A single clone holds every package:

```
git clone https://github.com/niftymonkey/regimen.git
```

Then, from the clone, run the root installer once:

```
cd regimen
./install.sh
```

That thin wrapper runs `bun install`, then `regimen install`, the `@regimen/cli` orchestrator. `regimen install` composes `feedback install` (this instrument) then `enforcement install`, and self-links the `regimen` bin, so afterward `regimen install` / `regimen uninstall` is the bare command. To preview without changing anything, `./install.sh --dry-run`.

Feedback is one instrument the orchestrator composes. `feedback install` (run for you by the orchestrator, or directly for a Feedback-only install) does, in order:

1. Enables capture (writes the enabled flag, the single capture-and-storage privacy gate).
2. Installs and loads the loader daemon as a user-level launchd agent (`~/Library/LaunchAgents/dev.niftymonkey.regimen-feedback.plist`), which drains the capture buffer into the local SQLite store. `KeepAlive` is gated on unsuccessful exit, so it restarts on a crash and at login but a deliberate `feedback stop` stays stopped.
3. Wires the capture hook into `~/.codex/hooks.json` on the five Codex events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact). This merge is idempotent and never clobbers your own hooks, nor any enforcement gate leaves the enforcement package's install added (see Idempotency below).
4. Installs both bundled skills into `~/.codex/skills/`: `feedback-evidence` (the deterministic evidence check) and `feedback-judgment` (its judged twin).
5. Links the `feedback` CLI onto PATH with `bun link`, so the in-session skills can invoke `feedback ...` in the agent's shell.

The Enforcement pillar (discipline gates such as the `rm-rf` safe floor) is wired by `enforcement install`, which the orchestrator sequences right after `feedback install`; it is the sibling [`packages/enforcement`](../enforcement) package and can also be run on its own. Either way, it wires its gate leaves into the same `~/.codex/hooks.json` without disturbing Feedback's capture hook.

### Flags

- `--dry-run` previews every step and changes nothing.

The harness is auto-detected per invocation, or set explicitly with the `REGIMEN_HARNESS` environment variable. For a non-default harness config home (the dual-home case), point the harness's own config-home environment variable at the target home before running the install.

## Idempotency, re-run, and uninstall

The install is safe to re-run: it recognizes its own capture-hook entries by a marker, so a second run never duplicates them and never reorders or removes your own hooks or an enforcement install's gate leaves. Re-running after moving the clone re-homes Feedback's hook command to the new path in place.

- `feedback wire-hooks` / `feedback unwire-hooks` (re)wire or remove just Feedback's capture hook. Use these to re-home after a clone move without touching the daemon, the skills, or any enforcement gates.
- `feedback uninstall` tears down what Feedback set up, in reverse: disables capture, unwires Feedback's capture hook (leaving your own hooks and any enforcement gate leaves intact), removes the bundled skills, uninstalls the daemon, and runs `bun unlink`.

## Verify (exit criterion)

1. Capture. Run a short Codex session that issues a shell command, then check that events landed:

   ```
   feedback status
   ```

   `last event` should be recent and `daemon` should report running.

2. Read-back (Feedback evidence + judgment). From the same working directory the session ran in:

   ```
   feedback evidence
   ```

   In a live session the agent gets the same digest by invoking the `feedback-evidence` skill, and a judged verdict (Intent, Outcome, evidence-anchored assessment) by invoking `feedback-judgment`, which runs `feedback assess` and makes a live model call. Export `ANTHROPIC_API_KEY` for the judge.

Enforcement (gate denials) is verified separately, once the enforcement package is installed; its own setup guide covers that step. When a gate denies a tool call it records a `gate.denial` event, which surfaces in the read-back from step 2 under `gateDenials` exactly as any other captured signal does, because Feedback reads it from the same store.

## Caveats and known limits

- Hook trust and the hooks feature are build-dependent. Verify both on your installed Codex build (`codex features list`, plus any `/hooks` trust step) rather than assuming the published docs, which track a newer build than 0.128.0.
- Capture is the hooks path by default. The rollout-file tailer ships as the version-proof fallback and the judge-time transcript source; the daemon runs it when `REGIMEN_CODEX_SESSIONS_DIR` names a Codex sessions root (for example `~/.codex/sessions`), with an optional `REGIMEN_ROLLOUT_POLL_MS` cadence (default 5000). It is off unless that variable is set, so it does not double-capture alongside live hooks; enable it if app hooks regress during the trial. Codex has no session-end hook, so a session-end boundary is not emitted from hooks; the tailer supplies it for finished transcripts.
- Single-home assumption. This guide assumes the Mac case where the CLI and app share one `~/.codex`. Confirm that on the trial machine; if the app and CLI use different homes, point the harness's config-home environment variable at each home and run the install once per home, and point the daemon at the home that is written to.
- `bun` on the hook PATH. If hooks appear not to fire, the most common cause is `bun` missing from the PATH of the shell Codex spawns hooks in. Make `bun` resolvable there.

## Manual setup (fallback)

If you cannot run the installer (an unusual topology, or to inspect exactly what gets wired), the steps it automates are: `bun install`; `feedback start`; `feedback install-daemon`; create `~/.codex/hooks.json` with the capture hook on the five events; `feedback install-skill`; `bun link`. The capture hook command is `bun /ABSOLUTE/PATH/TO/regimen/packages/feedback/hooks/capture-codex.ts` on each of SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, each as a `{ "type": "command", "command": "..." }` entry in a matcher-group, for example:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /ABSOLUTE/PATH/TO/regimen/packages/feedback/hooks/capture-codex.ts"
          }
        ]
      }
    ]
  }
}
```

Repeat the capture entry on the other four events. The discipline gates are wired separately by the enforcement package into the same file; see that package for its manual fallback. Do not also ship a repo-local `.codex/hooks.json`: Codex loads every hook source, so a user-level hook plus a trusted repo-local one would double-fire.
