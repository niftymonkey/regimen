#!/usr/bin/env bash
# Thin bootstrap for the Regimen installer. No logic lives here: it installs
# workspace dependencies, then hands off to `regimen install`, the thin
# orchestrator (the @regimen/cli package) that shells out to each instrument's
# own install verb (Feedback, then Enforcement) and self-links the `regimen` bin
# so it becomes a bare command after the first run. Any flags are passed straight
# through, for example:
#
#   ./install.sh              install every instrument and self-link the regimen bin
#   ./install.sh --no-gates   capture only, no enforcement gates
#   ./install.sh --gate rm-rf only the safe rm-rf gate
#   ./install.sh --dry-run    preview every step, change nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bun install
exec bun packages/cli/src/cli/index.ts install "$@"
