# Installing Regimen on native Windows (PowerShell)

> Status: native Windows is a first-class target, but it is **not yet validated end to end**. The Windows install code (the `schtasks` Task Scheduler daemon, the `%APPDATA%\regimen` data dir, the per-harness config resolution) has unit tests but has never been run against real agent CLIs on a live Windows box. This is the open acceptance item (DoD D). Treat this document as both an install runbook and the acceptance checklist: do each step, run the verification under it, and note anything that does not match. The three things most likely to need attention are flagged inline as **WATCH**.

This is for the case where your agent CLIs (Claude Code, Codex, Copilot, Gemini) run **directly in Windows** and you drive everything from **PowerShell**. If instead you run the CLIs inside WSL, install Regimen inside WSL with `./install.sh` (the proven Linux path) rather than this document, because Regimen must be installed in the same environment the CLIs run in or it captures nothing.

## What an install actually does

`regimen install` (the unified CLI) does five things, in order, for the resolved harness:

1. Enables capture (writes an enabled flag under the data dir).
2. Installs the loader **daemon**: on Windows it writes a Task Scheduler XML to `%APPDATA%\regimen\regimen-feedback.task.xml` and registers it as a scheduled task named `regimen-feedback` (a logon-triggered task that runs the loader with restart-on-failure).
3. Wires the **capture hook** into the harness's own config file (for example `%USERPROFILE%\.claude\settings.json`), as a `bun <clone>\packages\feedback\hooks\capture-<harness>.ts` command.
4. Copies the bundled **Guidance skills** into the harness's skills folder.
5. Self-links the `regimen` bin (`bun link`) so `regimen` becomes a bare command.

The data directory is `%APPDATA%\regimen`. It holds the capture buffer and the SQLite store; it survives uninstall, so capture history is never lost to a reinstall.

## Prerequisites

Run these in PowerShell.

```powershell
# Bun for Windows (installs to %USERPROFILE%\.bun and adds it to PATH).
powershell -c "irm bun.sh/install.ps1 | iex"
```

Then **open a fresh PowerShell window** so `bun` is on PATH. Confirm:

```powershell
bun --version
git --version    # Git for Windows; install from https://git-scm.com if missing
```

`jq` and `ANTHROPIC_API_KEY` are only needed for specific pieces:

- `jq` is used by two of the enforcement gates (`em-dash`, `inline-message`), which are bash scripts. See the gate note below; you do not need `jq` for the first install if you stick to the `rm-rf` gate.
- `ANTHROPIC_API_KEY` (set with `$env:ANTHROPIC_API_KEY = "..."`) is needed only when you run `regimen assess` (the judge), not for capture.

## Install

```powershell
# 1. Clone the monorepo.
git clone https://github.com/niftymonkey/regimen.git
cd regimen

# 2. Install workspace dependencies.
bun install

# 3. Choose the harness you are installing for, and preview first.
#    There is no ./install.sh on native Windows (it is bash); call the CLI directly.
$env:REGIMEN_HARNESS = "claude"     # or: codex | copilot | gemini
bun packages\cli\src\cli\index.ts install --gate rm-rf --dry-run

# 4. If the dry-run plan looks right, run it for real.
bun packages\cli\src\cli\index.ts install --gate rm-rf
```

Notes on the flags and the harness:

- **Always set `$env:REGIMEN_HARNESS`** in PowerShell. Auto-detection relies on a CLI-set marker env var that a plain PowerShell session will not have, so set it explicitly.
- **`--gate rm-rf` is deliberate on Windows.** Of the three bundled gates, only `rm-rf` is a cross-platform TypeScript script. The `em-dash` and `inline-message` gates are bash scripts and need a POSIX shell (for example Git Bash's `sh`) plus `jq` on PATH to run; on a stock Windows box they will not fire. Start with `--gate rm-rf` (or `--no-gates` for capture only), and only add the bash gates once you have a `sh` interpreter available and have verified they execute.
- **Gemini installs per workspace.** For Gemini, run the install from inside the workspace (directory) where you launch `gemini`; the capture hook lands in `<that-dir>\.gemini\settings.json`, not a global config. The CLI prints a one-line notice when it does this.
- **Several harnesses at once:** `bun packages\cli\src\cli\index.ts install --harnesses claude codex copilot --gate rm-rf` loops the install. Keep Gemini separate and per-workspace as above.

After the install self-links `regimen`, open a **new PowerShell window** so the linked `regimen` command is on PATH. In the same window you installed from, keep using the full `bun packages\cli\src\cli\index.ts <command>` form.

## Start the daemon now

The scheduled task is registered with a **logon trigger**, so it starts on your next logon. To start capturing immediately without logging out and back in:

```powershell
regimen daemon start
# or, same shell as install:  bun packages\cli\src\cli\index.ts daemon start
```

## Verify (this is the acceptance checklist)

```powershell
# Program + daemon state.
regimen status
regimen daemon status

# The scheduled task exists and is registered.
schtasks /Query /TN regimen-feedback

# The capture hook landed in the harness config (Claude shown).
type $env:USERPROFILE\.claude\settings.json

# The data dir now exists.
dir $env:APPDATA\regimen
```

Then run a real session in the harness and confirm capture flowed:

```powershell
# After running your agent CLI on a small task:
regimen evidence        # quantitative digest of the current session
regimen assess          # qualitative judge (needs ANTHROPIC_API_KEY; paid)
```

If `regimen evidence` shows a real session with events, the full chain (hook fired, buffer written, daemon drained it to the store, read path works) is proven on Windows.

## WATCH: the three things not yet validated on Windows

These are the open DoD D wrinkles. If capture does not flow, check these first.

1. **WATCH: does `bun <path>` fire as a hook command under each CLI?** The harness config now contains a `bun <abs-path>\capture-<harness>.ts` command. When the CLI fires a hook it spawns that command, which requires `bun` to be resolvable on the PATH the CLI uses for hooks, and the CLI to accept a plain command-string hook on Windows. If capture is silently empty, this is the most likely cause. Confirm `bun` is on the system PATH (the Bun installer adds `%USERPROFILE%\.bun\bin`; a fresh shell or re-logon may be needed for the CLI to inherit it).
2. **WATCH: does the `schtasks` daemon actually run and drain the buffer?** Confirm the task is present (`schtasks /Query /TN regimen-feedback`), that `regimen daemon status` reports it running after `regimen daemon start`, and that the backlog in `regimen status` falls (the daemon is consuming the buffer) as events come in.
3. **WATCH: path and config-home resolution.** The data dir is `%APPDATA%\regimen`; each harness's config home is its env var or the default under `%USERPROFILE%` (`CLAUDE_CONFIG_DIR` / `.claude`, `CODEX_HOME` / `.codex`, `COPILOT_HOME` / `.copilot`, `GEMINI_CONFIG_DIR` / `.gemini`). If hooks or skills land in an unexpected place, check those env vars and the path separators in the written config.

Two more known, non-Windows-specific notes:

- **Codex hook trust:** freshly installed Codex hooks are untrusted. Interactive Codex needs a one-time manual trust approval or capture silently will not fire; non-interactive `codex exec` needs `--dangerously-bypass-hook-trust`. The installer prints this notice when wiring Codex.
- **The bash gates:** as above, `em-dash` and `inline-message` need a POSIX shell and `jq`; on stock Windows they will not run, so prefer `--gate rm-rf` until you have provisioned `sh`.

## Per-harness reference

| Harness | Config home env var | Default home | Hooks file | Skills folder |
| --- | --- | --- | --- | --- |
| Claude | `CLAUDE_CONFIG_DIR` | `%USERPROFILE%\.claude` | `settings.json` | `<home>\skills` |
| Codex | `CODEX_HOME` | `%USERPROFILE%\.codex` | `hooks.json` | `<home>\skills` |
| Copilot | `COPILOT_HOME` | `%USERPROFILE%\.copilot` | `hooks\hooks.json` | `<home>\skills` |
| Gemini | `GEMINI_CONFIG_DIR` | `%USERPROFILE%\.gemini` | `settings.json` (per workspace: `<cwd>\.gemini\settings.json`) | `<home>\skills` |

## Updating later

Once this first install has run, it has written an install manifest at `%APPDATA%\regimen\install-manifest.json`. From then on, after you `git pull` (or move) the clone, run:

```powershell
regimen update           # re-resolves the clone and loader paths, re-runs the
                         # recorded installs, cycles the daemon, restamps the manifest
```

`regimen update` previews with `--dry-run` like every lifecycle verb. You only ever need uninstall-then-reinstall again if the manifest is lost. To remove everything (the data dir is preserved):

```powershell
regimen uninstall
```
