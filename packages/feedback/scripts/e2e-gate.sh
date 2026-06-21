#!/usr/bin/env bash
#
# Four-harness end-to-end live-capture + judge gate for Regimen Feedback.
#
# Fires a REAL (paid) headless agent for one harness, in an ISOLATED config home
# and an ISOLATED data dir (the user's live ~/.<harness> and live feedback store
# are never written), on a tiny deterministic bug-fix task, then asserts BOTH
# faces of Feedback:
#   (1) LIVE CAPTURE: real hooks -> envelopes -> loader translator -> events in
#       the store, surfaced by `feedback evidence` (the quantitative face).
#   (2) JUDGE: `feedback assess` returns a complete verdict (intent + outcome +
#       prose), the qualitative face.
#
# This is the durable acceptance for the four-harness readiness push. It is NOT
# part of `bun run check` because it makes paid model calls; run it deliberately:
#
#   packages/feedback/scripts/e2e-gate.sh <claude|codex|gemini|copilot>
#
# Per-harness specifics were producer-confirmed on a real box (Claude Code
# 2.1.185, codex-cli 0.141.0, GitHub Copilot CLI 1.0.63, Gemini CLI 0.47.0); see
# the inline notes. Each harness needs its own auth seeded into the isolated home
# (a copy of the real credential file; the real home is only read) and its own
# headless launch flags.
set -uo pipefail

HARNESS="${1:-}"
case "$HARNESS" in
  claude | codex | gemini | copilot) ;;
  *)
    echo "usage: $0 <claude|codex|gemini|copilot>" >&2
    exit 2
    ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG="$REPO/packages/feedback"
CLI="$PKG/src/cli/index.ts"
LOADER="$PKG/src/loader/run.ts"

ROOT="$(mktemp -d "/tmp/regimen-e2e-${HARNESS}.XXXXXX")"
HOME_DIR="$ROOT/home"
DATA_DIR="$ROOT/data"
WORK_DIR="$ROOT/work"
mkdir -p "$HOME_DIR" "$DATA_DIR" "$WORK_DIR"
touch "$DATA_DIR/feedback.enabled"

# The bug-fix fixture: a deterministic, assessable task. The order of the
# divisibility checks is wrong, so fizzbuzz(15) returns "Fizz". A correct fix
# yields a clean pass/fail outcome AND substantive process for the judge prose.
cat >"$WORK_DIR/fizzbuzz.py" <<'PY'
def fizzbuzz(n):
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    if n % 15 == 0:
        return "FizzBuzz"
    return str(n)


assert fizzbuzz(15) == "FizzBuzz", f"expected FizzBuzz, got {fizzbuzz(15)}"
assert fizzbuzz(3) == "Fizz"
assert fizzbuzz(5) == "Buzz"
assert fizzbuzz(7) == "7"
print("all asserts passed")
PY

PROMPT="The file fizzbuzz.py in this directory has a bug: fizzbuzz(15) returns the wrong value because the order of the divisibility checks is wrong. Fix the bug so all the asserts in the file pass, then run 'python3 fizzbuzz.py' to confirm it prints 'all asserts passed'."

echo "== regimen four-harness e2e gate: $HARNESS =="
echo "   isolated root: $ROOT"

seed() { cp -p "$1" "$HOME_DIR/" 2>/dev/null || true; }

case "$HARNESS" in
  claude)
    # Auth lives outside CLAUDE_CONFIG_DIR, so no seed is needed. Hooks wire as
    # the nested-matcher-groups format the planner already emits.
    REGIMEN_HARNESS=claude CLAUDE_CONFIG_DIR="$HOME_DIR" REGIMEN_DATA_DIR="$DATA_DIR" \
      bun "$CLI" wire-hooks >/dev/null
    ( cd "$WORK_DIR" && CLAUDE_CONFIG_DIR="$HOME_DIR" REGIMEN_DATA_DIR="$DATA_DIR" \
      timeout 300 claude -p "$PROMPT" --dangerously-skip-permissions ) >"$ROOT/run.out" 2>&1
    SESSION_KEY="session_id"
    ;;

  codex)
    # Auth + model config live in CODEX_HOME; seed them. Fresh hooks are
    # untrusted and silently skipped in non-interactive exec, so bypass hook
    # trust; an open stdin makes exec hang, so close it.
    seed ~/.codex/auth.json
    seed ~/.codex/config.toml
    REGIMEN_HARNESS=codex CODEX_HOME="$HOME_DIR" REGIMEN_DATA_DIR="$DATA_DIR" \
      bun "$CLI" wire-hooks >/dev/null
    ( cd "$WORK_DIR" && CODEX_HOME="$HOME_DIR" REGIMEN_DATA_DIR="$DATA_DIR" \
      timeout 300 codex exec --dangerously-bypass-approvals-and-sandbox \
        --dangerously-bypass-hook-trust --skip-git-repo-check "$PROMPT" </dev/null \
      ) >"$ROOT/run.out" 2>&1
    SESSION_KEY="session_id"
    ;;

  copilot)
    # COPILOT_HOME isolates the config home; seed its auth/config. Only
    # USER-level hooks at $COPILOT_HOME/hooks/*.json fire in headless -p (repo
    # .github/hooks do NOT). The per-leaf env block points capture at the
    # isolated data dir (copilot sanitizes inherited env). The wire-hooks planner
    # emits the versioned-command-leaves format; here we add the test-only env.
    seed ~/.copilot/config.json
    seed ~/.copilot/permissions-config.json
    REGIMEN_HARNESS=copilot COPILOT_HOME="$HOME_DIR" REGIMEN_DATA_DIR="$DATA_DIR" \
      bun "$CLI" wire-hooks >/dev/null
    # Inject the isolated data dir into each leaf's env so capture writes to it.
    bun -e '
      const fs = require("fs");
      const p = process.argv[1];
      const data = process.argv[2];
      const f = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const ev of Object.keys(f.hooks))
        for (const leaf of f.hooks[ev]) leaf.env = { REGIMEN_DATA_DIR: data };
      fs.writeFileSync(p, JSON.stringify(f, null, 2));
    ' "$HOME_DIR/hooks/hooks.json" "$DATA_DIR"
    ( cd "$WORK_DIR" && COPILOT_HOME="$HOME_DIR" \
      timeout 300 copilot -C "$WORK_DIR" -p "$PROMPT" --allow-all-tools </dev/null \
      ) >"$ROOT/run.out" 2>&1
    SESSION_KEY="sessionId"
    ;;

  gemini)
    # Seed credentials (api-key auth) + auth-type settings. NOTE the gemini
    # hooks-writing gaps (see the driver doc): gemini requires each hook group to
    # carry a `name` AND a `matcher`, sanitizes the hook env, and in headless -p
    # fires PROJECT-level hooks (a named+matcher .gemini/settings.json in the
    # workspace) rather than the user-level settings.json the planner writes. So
    # this path hand-builds the project-level hooks with a wrapper that sets the
    # isolated data dir, instead of `feedback wire-hooks`. GEMINI_CLI_TRUST_WORKSPACE
    # is required to run headless in a fresh dir.
    seed ~/.gemini/gemini-credentials.json
    seed ~/.gemini/google_accounts.json
    seed ~/.gemini/settings.json
    mkdir -p "$WORK_DIR/.gemini"
    cat >"$WORK_DIR/.gemini/capture-wrapper.sh" <<WRAP
#!/usr/bin/env bash
export REGIMEN_DATA_DIR="$DATA_DIR"
exec bun "$PKG/hooks/capture-gemini.ts"
WRAP
    chmod +x "$WORK_DIR/.gemini/capture-wrapper.sh"
    W="$WORK_DIR/.gemini/capture-wrapper.sh"
    cat >"$WORK_DIR/.gemini/settings.json" <<JSON
{
  "hooks": {
    "SessionStart": [{"matcher":"*","hooks":[{"name":"regimen-capture-sessionstart","type":"command","command":"$W"}]}],
    "SessionEnd": [{"matcher":"*","hooks":[{"name":"regimen-capture-sessionend","type":"command","command":"$W"}]}],
    "BeforeAgent": [{"matcher":"*","hooks":[{"name":"regimen-capture-beforeagent","type":"command","command":"$W"}]}],
    "BeforeTool": [{"matcher":"*","hooks":[{"name":"regimen-capture-beforetool","type":"command","command":"$W"}]}],
    "AfterTool": [{"matcher":"*","hooks":[{"name":"regimen-capture-aftertool","type":"command","command":"$W"}]}]
  }
}
JSON
    ( cd "$WORK_DIR" && GEMINI_CLI_TRUST_WORKSPACE=true GEMINI_CONFIG_DIR="$HOME_DIR" \
      timeout 300 gemini -p "$PROMPT" --yolo </dev/null ) >"$ROOT/run.out" 2>&1
    SESSION_KEY="session_id"
    ;;
esac

BUFFER="$DATA_DIR/buffer/current.jsonl"
if [ ! -s "$BUFFER" ]; then
  echo "FAIL [$HARNESS]: no capture envelopes were written (hooks did not fire)" >&2
  echo "   agent output tail:" >&2
  tail -5 "$ROOT/run.out" >&2
  exit 1
fi
ENVELOPES="$(wc -l <"$BUFFER")"
SESSION="$(bun -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n")[0];console.log(JSON.parse(l).payload[process.argv[2]])' "$BUFFER" "$SESSION_KEY")"

# Drain the buffer through the loader (it drains any pre-existing buffer on
# startup), then stop it.
REGIMEN_DATA_DIR="$DATA_DIR" bun "$LOADER" >"$ROOT/loader.out" 2>&1 &
LPID=$!
for _ in $(seq 1 60); do
  N="$(bun -e 'const{Database}=require("bun:sqlite");try{const db=new Database(process.argv[1],{readonly:true});console.log(db.prepare("SELECT COUNT(*) n FROM events").get().n)}catch(e){console.log(0)}' "$DATA_DIR/feedback.db" 2>/dev/null)"
  [ "${N:-0}" -ge "$ENVELOPES" ] 2>/dev/null && break
  sleep 0.2
done
kill -TERM "$LPID" 2>/dev/null
wait "$LPID" 2>/dev/null

# Face 1: live capture. Assert events landed, none quarantined, tools recorded.
read -r EVENTS QUARANTINED < <(bun -e '
  const { Database } = require("bun:sqlite");
  const db = new Database(process.argv[1], { readonly: true });
  const e = db.prepare("SELECT COUNT(*) n FROM events").get().n;
  const q = db.prepare("SELECT COUNT(*) n FROM quarantine").get().n;
  console.log(e, q);
' "$DATA_DIR/feedback.db")
TOOLS="$(REGIMEN_DATA_DIR="$DATA_DIR" bun "$CLI" evidence --session "$SESSION" 2>/dev/null | bun -e 'const d=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));console.log(d.counts?.toolCallCount ?? 0)')"

echo "   capture: $ENVELOPES envelopes -> $EVENTS events ($QUARANTINED quarantined), $TOOLS tool calls"
CAPTURE_OK=1
[ "${EVENTS:-0}" -ge 1 ] || CAPTURE_OK=0
[ "${QUARANTINED:-1}" -eq 0 ] || CAPTURE_OK=0
[ "${TOOLS:-0}" -ge 1 ] || CAPTURE_OK=0

# Face 2: judge. assess reads the harness transcript (not the captured events)
# and runs the judge LLM, resolving the transcript under the harness config home.
case "$HARNESS" in
  claude) ASSESS_ENV=(CLAUDE_CONFIG_DIR="$HOME_DIR") ;;
  codex) ASSESS_ENV=(CODEX_HOME="$HOME_DIR") ;;
  copilot) ASSESS_ENV=(COPILOT_HOME="$HOME_DIR") ;;
  gemini) ASSESS_ENV=(GEMINI_CONFIG_DIR="$HOME_DIR") ;;
esac
ASSESS_JSON="$(env REGIMEN_HARNESS="$HARNESS" "${ASSESS_ENV[@]}" REGIMEN_DATA_DIR="$DATA_DIR" \
  bun "$CLI" assess --session "$SESSION" 2>"$ROOT/assess.err")" || true

JUDGE_OK=0
if [ -n "$ASSESS_JSON" ]; then
  eval "$(echo "$ASSESS_JSON" | bun -e '
    const d = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf8"));
    const intent = d.assignment?.signals?.find((s) => s.signalName === "intent")?.value ?? "";
    const outcome = d.outcome?.value ?? "";
    const complete = d.complete ? 1 : 0;
    console.log(`COMPLETE=${complete}; INTENT=${JSON.stringify(intent)}; OUTCOME=${JSON.stringify(outcome)}`);
  ')"
  echo "   judge: complete=$COMPLETE intent=$INTENT outcome=$OUTCOME (model: $(echo "$ASSESS_JSON" | bun -e 'console.log(JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")).model||"?")'))"
  [ "${COMPLETE:-0}" -eq 1 ] && JUDGE_OK=1
else
  echo "   judge: assess produced no verdict ($(tail -1 "$ROOT/assess.err" 2>/dev/null))"
fi

if [ "$CAPTURE_OK" -eq 1 ] && [ "$JUDGE_OK" -eq 1 ]; then
  echo "PASS [$HARNESS]: both faces present (live capture + judge)"
  exit 0
fi
echo "FAIL [$HARNESS]: capture_ok=$CAPTURE_OK judge_ok=$JUDGE_OK (artifacts in $ROOT)" >&2
exit 1
