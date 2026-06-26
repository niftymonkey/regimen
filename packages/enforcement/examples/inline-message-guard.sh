#!/usr/bin/env bash
# A reference discipline gate, harness-agnostic by construction.
#
# A universal pre-tool hook that denies an inline shell message body (a heredoc)
# on a git/gh message-bearing command (git commit, gh pr|issue|release
# create|edit). Wrapping a commit/PR/issue body in a shell heredoc repeatedly
# breaks on escaping; the discipline is to pass the message with -m or
# --body-file.
#
# The rule and the deny (exit 2 with the reason on stderr, the form Claude and
# Codex share) live in this portable script body.

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
  printf '%s\n' \
    "BLOCKED: $REASON" \
    "  git commit      -> git commit -m \"single-line subject\"" \
    "  gh pr create    -> write the body to a file, then --body-file <path>" >&2
  exit 2
fi

exit 0
