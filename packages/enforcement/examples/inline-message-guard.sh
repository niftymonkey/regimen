#!/usr/bin/env bash
# A reference discipline gate, harness-agnostic by construction.
#
# A universal pre-tool hook that denies an inline shell message body (a heredoc)
# on a git/gh message-bearing command (git commit, gh pr|issue|release
# create|edit), and records the denial so the Enforcement instrument sees it.
# Wrapping a commit/PR/issue body in a shell heredoc repeatedly breaks on
# escaping; the discipline is to pass the message with -m or --body-file.
#
# The rule and the deny (exit 2 with the reason on stderr, the form Claude and
# Codex share) live in this portable script body; the harness label comes from
# REGIMEN_HARNESS, and recording is delegated to the harness-agnostic
# emit-denial CLI. bun is needed only to RECORD: if it is absent, the deny still
# fires, only the telemetry is skipped.
#
# The emitter is resolved self-relative to this script's own directory so a moved
# clone still works; REGIMEN_ENFORCEMENT_DIR overrides the resolved location.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMITTER="${REGIMEN_ENFORCEMENT_DIR:-$SCRIPT_DIR/..}/hooks/emit-denial.ts"
GATE_ID="inline-message-guard"
REASON="inline shell message bodies are not allowed for git/gh message commands; use -m or --body-file"

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Only message-bearing git/gh commands are guarded.
guard_pattern='(^|[[:space:];&|(])(git[[:space:]]+commit|gh[[:space:]]+(pr|issue|release)[[:space:]]+(create|edit))([[:space:]]|$)'
if ! printf '%s' "$cmd" | grep -qE "$guard_pattern"; then
  exit 0
fi

# An inline message body: <<EOF, <<'EOF', <<"EOF", <<-EOF, any tag name.
if printf '%s' "$cmd" | grep -qE "<<-?[[:space:]]*['\"]?[A-Za-z_][A-Za-z0-9_]*"; then
  # Block unconditionally; record the denial only when the harness is known.
  # The harness is the value the installer baked into REGIMEN_HARNESS; with none
  # set the gate still blocks but skips the emit rather than stamping a wrong
  # harness, matching the rm-rf gate's no-default behavior.
  if [ -n "${REGIMEN_HARNESS:-}" ]; then
    command -v bun >/dev/null 2>&1 &&
      printf '%s' "$input" | bun "$EMITTER" --from-hook \
        --gate "$GATE_ID" --harness "$REGIMEN_HARNESS" --reason "$REASON"
  fi
  printf '%s\n' \
    "BLOCKED: $REASON" \
    "  git commit      -> git commit -m \"single-line subject\"" \
    "  gh pr create    -> write the body to a file, then --body-file <path>" >&2
  exit 2
fi

exit 0
