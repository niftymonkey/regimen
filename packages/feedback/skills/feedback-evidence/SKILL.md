---
name: feedback-evidence
description: "Pull deterministic evidence-layer signals about the current conversation from Regimen's Feedback store, so the agent can self-correct mid-task or answer how the session is going. Use mid-task to notice churn, tool thrash, or a stall before continuing, or when the engineer asks how the session is going."
---

# feedback-evidence: in-session evidence check

Pull the evidence-layer signals Regimen's Feedback instrument has recorded for the _current_ conversation, and read them back into context. Use this to self-correct mid-task (notice churn, tool thrash, or a stall before continuing), or when the engineer asks how the session is going.

The signals are deterministic facts: counts and timestamps, with no verdict attached. You are the interpreter. Weigh each signal against what you were actually doing.

## Process

### 1. Run the evidence query

```bash
regimen evidence
```

The command resolves the current session itself from your working directory, so it needs no arguments. It detects which agent CLI it is running inside, prefers the session id that the Regimen capture hook stamped for this cwd on SessionStart, and falls back to the most-recently-active session for this harness when no stamp is present.

The command reads the local SQLite store directly. It makes no network call and invokes no model.

### 2. Handle the outcome

- **`regimen: command not found`**: Regimen is not installed on this machine. Tell the engineer, and stop; there is nothing to report.
- **`could not determine the harness`**: the CLI could not tell which agent harness it is running inside. This is an environment problem, not a session problem. Say so, and stop.
- **`"known": false`** with a note about resolving the session: the current session could not be identified (no stamp and no transcript found). Capture may not be installed. Say so, and stop.
- **`"known": false`** with a note that no events were recorded yet: the store has no record of this conversation yet. The capture daemon may not have drained the buffer, which is expected early in a session. Say so, and stop.
- **`"known": true`**: a digest came back. Continue to step 3.

### 3. Read the digest

The digest is one JSON object. Its fields:

- `conversation`: harness, model, `cwd`, and the start, first-event, last-event, and end timestamps. `cwd` is the working directory this conversation ran in, the anchor for which body of work it belongs to; it is `null` when no event reported one. `endedAt: null` means the conversation is still open (it always is when you invoke this). Some fields come from the transcript tailer rather than from hooks, and may be null when only hook capture has run.
- `staleness.openMs` and `staleness.idleMs`: how long the conversation has been open, and how long since the last recorded event.
- `counts`: prompts, tool calls, compactions, gate denials, and total events.
- `toolMix`: calls per tool, most-used first.
- `skillUsage`: skills invoked this conversation with their invocation counts, most-used first. Empty when no skill has been invoked.
- `repeatedFileEdits`: files edited more than once, most-edited first. Per-file churn comes from the transcript tailer, so it may be empty when only hook capture has run.
- `gateDenials`: tool calls an Enforcement gate blocked.

### 4. Interpret in context, then act

Each signal is a fact, not a judgment. Weigh it against the work you were doing:

- A high `editCount` on one file in `repeatedFileEdits` can be churn worth stepping back from, or a disciplined refactor converging. You know which.
- One tool dominating `toolMix` can be a focused investigation or unproductive thrash.
- `skillUsage` shows which guidance you actually pulled in. A skill you were asked to use but that is absent here is guidance you skipped; a skill invoked many times may be load-bearing for this conversation.
- A large `idleMs` can mean the conversation stalled.
- `compactionCount` above zero is a sign of context strain.
- A `gateDenial` you have not since worked around is worth revisiting.

If the engineer asked, report the relevant signals concisely. Otherwise, fold any observation that should change your approach into your next move, and carry on.

## Notes

- Session-id resolution is the only harness-specific step. The `regimen evidence` command and the digest it print are harness-agnostic; the CLI auto-detects the harness and selects the right resolver.
- Resolution has one known limitation: if two sessions run in the same working directory at once, the per-cwd stamp cannot tell them apart, and the most-recently-active session wins.
- The digest never tells you whether something is good or bad. That is deliberate: a deterministic threshold cannot tell a disciplined refactor from thrash, but you, with the whole conversation in context, can.
