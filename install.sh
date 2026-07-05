#!/usr/bin/env bash
# Thin bootstrap for the Regimen installer. No logic lives here: it installs
# workspace dependencies, then hands off to `regimen install`, the unified
# orchestrator (the @regimen/cli package) that dispatches to each pillar's
# install logic in-process (capture first, then the enforcement and guidance
# operator skills) and self-links the `regimen` bin so it becomes a bare command
# after the first run. Any flags are passed straight through, for example:
#
#   ./install.sh                                        install for the env-resolved harness
#   ./install.sh --all                                  install for every supported harness
#   ./install.sh --harnesses claude --harnesses codex   named harnesses (repeat the flag)
#   ./install.sh --dry-run                              preview every step, change nothing
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bun install
exec bun packages/cli/src/cli/index.ts install "$@"
