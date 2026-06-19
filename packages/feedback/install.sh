#!/usr/bin/env bash
# Thin bootstrap for the unified Regimen installer. No logic lives here: it
# installs dependencies, then hands off to `feedback install`, which stands up
# all three pillars (Feedback capture + daemon, Guidance skills, Enforcement
# gates) on this machine. Any flags are passed straight through, for example:
#
#   ./install.sh              wire capture + all three gates, install everything
#   ./install.sh --no-gates   capture only, no enforcement gates
#   ./install.sh --gate rm-rf only the safe rm-rf gate
#   ./install.sh --dry-run    preview every step, change nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bun install
exec bun src/cli/index.ts install "$@"
