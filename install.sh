#!/usr/bin/env bash
# Thin bootstrap for the Regimen installer. No logic lives here: it installs
# workspace dependencies, then hands off to `regimen install`, the unified
# orchestrator (the @regimen/cli package) that dispatches to each instrument's
# install logic in-process (capture first, then the gates) and self-links the
# `regimen` bin so it becomes a bare command after the first run. Any flags are
# passed straight through, for example:
#
#   ./install.sh              install every instrument and self-link the regimen bin
#   ./install.sh --no-gates   capture only, no enforcement gates
#   ./install.sh --gate rm-rf only the safe rm-rf gate
#   ./install.sh --dry-run    preview every step, change nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bun install
exec bun packages/cli/src/cli/index.ts install "$@"
