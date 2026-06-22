#!/usr/bin/env pwsh
# Thin bootstrap for the Regimen installer on Windows, the PowerShell twin of
# install.sh. No logic lives here: it installs workspace dependencies, then hands
# off to `regimen install`, the unified orchestrator (the @regimen/cli package)
# that dispatches to each instrument's install logic in-process (capture first,
# then the gates) and self-links the `regimen` bin so it becomes a bare command
# after the first run. Any flags pass straight through, for example:
#
#   .\install.ps1                                          install for the env-resolved harness
#   .\install.ps1 --harnesses claude --harnesses codex     several harnesses (repeat the flag)
#   .\install.ps1 --all                                    every harness
#   .\install.ps1 --no-gates                               capture only, no enforcement gates
#   .\install.ps1 --gate rm-rf                             only the cross-platform rm-rf gate
#   .\install.ps1 --dry-run                                preview every step, change nothing
#
# Run it from inside the clone. For Gemini's per-workspace install, use the bare
# `regimen install --harnesses gemini` from the workspace instead: this script
# returns to the clone directory, but Gemini's hook must land where you run it.
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# $ErrorActionPreference does not stop on a native command's nonzero exit, so the
# loader's own exit code is checked explicitly, mirroring `set -e` in install.sh.
bun install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

bun packages/cli/src/cli/index.ts install @args
exit $LASTEXITCODE
