#!/usr/bin/env bash
# A reference discipline gate, harness-agnostic by construction.
#
# A universal pre-tool hook that denies a Write/Edit whose content contains an
# em dash (U+2014), and records the denial so the Enforcement instrument sees
# it. The rule logic and the deny (exit 2 with the reason on stderr, the form
# Claude and Codex share) live in this portable script body; the harness label
# comes from REGIMEN_HARNESS, and recording is delegated to the harness-agnostic
# emit-denial CLI. A harness with a different deny form adds a branch here or
# ships a memory-file fallback. bun is needed only to RECORD: if it is absent,
# the deny still fires, only the telemetry is skipped.
#
# The emitter is resolved self-relative to this script's own directory so a moved
# clone still works; REGIMEN_ENFORCEMENT_DIR overrides the resolved location.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMITTER="${REGIMEN_ENFORCEMENT_DIR:-$SCRIPT_DIR/..}/hooks/emit-denial.ts"
GATE_ID="em-dash-guard"
REASON="em dash (U+2014) is forbidden; use commas, colons, parentheses, or separate sentences"

input=$(cat)

content=$(printf '%s' "$input" | jq -r '
  [ .tool_input.content,
    .tool_input.new_string,
    (.tool_input.edits[]?.new_string)
  ] | map(select(. != null)) | join("\n")
')

if printf '%s' "$content" | LC_ALL=C grep -q $'\xe2\x80\x94'; then
  # Block unconditionally; record the denial only when the harness is known.
  # The harness is the value the installer baked into REGIMEN_HARNESS; with none
  # set the gate still blocks but skips the emit rather than stamping a wrong
  # harness, matching the rm-rf gate's no-default behavior.
  if [ -n "${REGIMEN_HARNESS:-}" ]; then
    command -v bun >/dev/null 2>&1 &&
      printf '%s' "$input" | bun "$EMITTER" --from-hook \
        --gate "$GATE_ID" --harness "$REGIMEN_HARNESS" --reason "$REASON"
  fi
  printf '%s\n' "Blocked: $REASON" >&2
  exit 2
fi

exit 0
