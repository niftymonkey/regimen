#!/usr/bin/env bash
# A reference discipline gate, harness-agnostic by construction.
#
# A universal pre-tool hook that denies a Write/Edit whose content contains an
# em dash (U+2014). The rule logic and the deny (exit 2 with the reason on
# stderr, the form Claude and Codex share) live in this portable script body. A
# harness with a different deny form adds a branch here or ships a memory-file
# fallback.

REASON="em dash (U+2014) is forbidden; use commas, colons, parentheses, or separate sentences"

input=$(cat)

content=$(printf '%s' "$input" | jq -r '
  [ .tool_input.content,
    .tool_input.new_string,
    (.tool_input.edits[]?.new_string)
  ] | map(select(. != null)) | join("\n")
')

if printf '%s' "$content" | LC_ALL=C grep -q $'\xe2\x80\x94'; then
  printf '%s\n' "Blocked: $REASON" >&2
  exit 2
fi

exit 0
