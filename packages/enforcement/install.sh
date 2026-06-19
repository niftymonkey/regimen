#!/usr/bin/env bash
# Thin bootstrap for the Enforcement instrument: install dependencies, then hand
# every argument to the CLI's install verb. No logic lives here.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
bun install
exec bun src/cli/index.ts install "$@"
