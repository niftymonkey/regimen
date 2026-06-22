---
name: feedback-judgment
description: "Pull a judged verdict on the current conversation from Regimen's Feedback store, the Intent, the Outcome, and an evidence-anchored assessment, for mid-session 'did this serve me so far?' checkpoints. Use at a meaningful checkpoint, a phase boundary, before a risky step, or when the engineer asks; it makes a live model call, so it is not free."
---

# feedback-judgment: in-session judged verdict

Pull a judged verdict for the _current_ conversation and read it back into context. This is the judged twin of `feedback-evidence`. Where evidence hands you deterministic facts and leaves the interpreting to you, judgment hands you the judge's interpretation already formed: an Intent, an Outcome, and an evidence-anchored assessment of how the conversation has gone so far.

**This is heavier than evidence. Use it deliberately.** `regimen assess` makes a LIVE model call: it costs money and takes a few seconds, where `feedback-evidence` is free and instant. It also writes the verdict to the store. Invoke it at a MEANINGFUL checkpoint, a phase boundary, before a risky step, or when the engineer asks "is this going well?", not reflexively and not on every turn.

## Process

### 1. Run the assessment

```bash
regimen assess
```

The command resolves the current session itself from your working directory, exactly as `feedback-evidence` does, so it needs no arguments. It detects which agent CLI it is running inside, prefers the session id the Regimen capture hook stamped for this cwd on SessionStart, and falls back to the most-recently-active session for this harness when no stamp is present. The command judges the conversation so far, supersedes any prior verdict for this session, and prints a `JudgmentDigest` as one JSON object on stdout.

Unlike `regimen evidence`, this command makes a network call to the judge model and writes the verdict to the local store.

### 2. Handle the outcome

- **`regimen: command not found`**: Regimen is not installed on this machine. Tell the engineer, and stop; there is nothing to assess.
- **`could not determine the harness`**: the CLI could not tell which agent harness it is running inside. This is an environment problem, not a session problem. Say so, and stop.
- **`"judged": false`**: the unjudged branch. Feedback is off, no assessment has run yet, or the transcript could not be read. The `note` field says which. Report it plainly, and stop; there is no verdict to lean on.
- **`"judged": true`**: a verdict came back. Continue to step 3.

### 3. Read the digest, curated

The judged digest is one JSON object. Surface it curated, not raw. Lead with these fields:

- `assignment.signals` contains the judged signals. Find the one with `signalName: "intent"`: its `value` names what the engineer was trying to do (one of `refactor`, `bug-fix`, `feature`, `test-writing`, `exploration`, `schema-change`, `other`). Lead with it: it frames everything else.
- `outcome` is the lone whole-conversation Outcome. Its `value` is an ordinal, ranked low to high: `abandoned` below `partial` below `accomplished-with-correction` below `accomplished-cleanly`. It is `null` when the run abstained on it.
- `assessment.prose` is the headline narrative: a readable synthesis of how the conversation went, with `assessment.anchors` citing the conversation chunks that justify it. It is `null` when the run abstained. This prose is the heart of the verdict; relay it.

Two fields are conditional:

- **Do NOT surface `provenance`** (`judgeModel`, `rubricVersion`, `promptVersion`). It exists for longitudinal comparability across runs, not for action in the loop. It is noise to the engineer mid-session.
- **Surface `complete` ONLY when it is `false`.** A `complete: false` run did not finish clean (insufficient evidence, an unparseable judge reply, or the judge unavailable); say so, and treat the verdict as provisional rather than leaning on it. When `complete` is `true`, do not mention it.

### 4. Interpret and act

The verdict is ALREADY the judge's interpretation, so act on it rather than re-deriving it. (This is the inversion from evidence, where you interpret raw facts yourself.)

- An Outcome of `accomplished-cleanly` is a green light: the conversation served its intent. Carry on.
- An Outcome of `accomplished-with-correction` or worse is a cue. Consider what steering it took to get here and whether to adjust course. The `assessment.prose` names the specific moments, and its anchors point at the chunks; use them to locate what went sideways.
- An `abandoned` or `partial` Outcome on an open conversation is a prompt to reconsider the approach before sinking more in.

If the engineer asked, report the verdict concisely: Intent, Outcome, and the gist of the assessment. Otherwise, fold any course-correction the verdict implies into your next move, and carry on.

## Notes

- Session-id resolution is the only harness-specific step. The `regimen assess` command and the digest it prints are harness-agnostic; the CLI auto-detects the harness and selects the right resolver. Resolution has the same one known limitation as evidence: if two sessions run in the same working directory at once, the per-cwd stamp cannot tell them apart, and the most-recently-active session wins.
- The conversation is open when you invoke this, so the verdict judges the conversation _so far_, not a finished session. Re-running later supersedes it with a fresh verdict over more of the conversation.
- This costs money and takes a few seconds, and it writes to the store. That is the price of a verdict over raw facts. Invoke it at meaningful checkpoints, not reflexively.
