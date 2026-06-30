# Bulk conversation judging (`assess --all`): design summary

> Explore-idea session, 2026-06-29; the sweep is now built, tested, and live-smoked against real captured conversations. Generic mechanism; the four-harness trial is one validating instance, not the spec.

## Problem / opportunity
The evidence layer is captured automatically for every conversation. The judgment layer (the LLM judge, `assess`) is produced only by running it by hand, one conversation at a time. To evaluate how work has gone across many conversations, an engineer must manually assess each one. There is no way to say "judge every conversation you know about, now." This blocks the cross-conversation read Regimen is built for, and surfaced concretely in a four-harness trial ("how are all my conversations, across all harnesses, doing").

## Target user
The engineer who wants the judgment layer to exist across many conversations on demand, rather than assessing one at a time. Comparing harnesses for a work eval is one instance of this generic need.

## Core requirements
Must-have:
- An on-demand command that iterates every selected conversation and runs the existing per-conversation `assess` on each, storing results identically to today.
- Default skips conversations already judged; `--force` re-judges everything (for when the judging mechanism itself changed).
- Selection reuses the existing `list` filters (harness, model, since, until, outcome); default is all conversations, all harnesses.
- Batched execution with a checkpoint between batches, so cost is learned empirically: run a batch, check provider usage, then continue / run all remaining / quit. Bounded and resumable: the first batch always runs, a non-interactive (no-tty) run stops after it rather than spending unattended, and re-running resumes because judged conversations are skipped.
- Self-narrating output: an opening accounting (matched / already judged / to judge), a contiguously numbered progress line per conversation carrying its outcome (or FAILED), and an end-of-run summary naming judged / failed / skipped counts and each failure by harness and session.
- Judge model is Opus 4.8 (the existing default); pinnable per sweep with `--judge-model`, and the backend (HTTP key vs local `claude` CLI) is auto-selected or forced with `--judge-via cli|api`, shared verbatim with single-session `assess`.

Nice-to-have (explicitly deferred):
- Automatic/proactive judging (scheduled or on session-end) reusing the same loop.
- The cross-conversation read over the persisted verdicts. Now given a direction (see "Cross-conversation read direction" below and the proposed ADR), not merely deferred: two co-equal capabilities, a verdict rollup and a practice-adherence check, built when the read need is concrete.

## Key decisions
1. Bulk judging is a flag on the existing command: `regimen assess --all`, not a new verb. It is the per-conversation judge applied to many conversations.
2. No new storage and no new per-conversation logic: each conversation is judged and persisted exactly as `assess` does today (`assessment_run` / `judged_signal` / `narrative`, keyed by session id).
3. No aggregation layer in this work. Reading the corpus stays compositional and out of band, consistent with dropping the baked `answer` command.
4. Default skip-already-judged; `--force` re-judges; the answering model id is recorded per run, so a model change is detectable and re-sweepable.
5. Cost control is empirical batching, not an estimate: default batch 10 (`--batch N`), with a single-keypress continue / run-all-remaining / quit between batches (`c`/Enter, `a`, `q`/Ctrl-C; stray keys ignored); the first batch always runs, a non-interactive (no-tty) run stops after it so a piped or backgrounded sweep cannot spend unbounded, and the whole sweep is resumable for free because already-judged conversations are skipped.
6. Selection is the existing `list` filter set: the sweep is `listSessions(filters)` minus already-judged, then `assess` each.
7. Continue-on-error and fail-loud on no backend: a conversation whose transcript has aged out is recorded as a failure inline (contiguous progress numbering, no gaps) and the sweep proceeds; the judge backend is resolved before any spend, and if none is available (no `ANTHROPIC_API_KEY` and no local `claude` fallback) the command exits non-zero with a clean one-line error and no stack.

## Constraints / boundaries
- `assess` reads each conversation's transcript from the harness's own files at judge time, not from the store. The sweep can only judge conversations whose transcripts still exist; ones aged out are skipped or error per-conversation, exactly as a manual `assess` would.
- The judge is metered (Anthropic key set; default Opus 4.8). Batching exists to keep that spend observable.
- Sequential execution; continue-on-error with an end-of-run summary.
- Harness- and model-agnostic; nothing here is specific to a harness or to the trial.

## Cross-conversation read direction (deferred)
The sweep exists to make the per-conversation verdict exist for the whole corpus; reading across that corpus is a separate, deferred design, now given a direction (proposed as its own ADR). The read is two co-equal capabilities over the same persisted verdicts, neither a headline over the other:
- A verdict rollup that aggregates the per-conversation assessment prose into how work is going, the recurring patterns, and concrete remedies.
- A practice-adherence check that verifies whether the engineer's own established practices (rules, conventions, established skills) are honored across conversations, and recommends per practice: enforce, reword, or retire.

Both earn their place by aggregating what no human reliably tallies and by correcting the drift between what the engineer remembers or feels and what the captured conversations show; a loud problem recurring across many conversations but never connected is as worth surfacing as a silent one never noticed. Two constraints are already fixed: the practice-adherence check is time-scoped (each conversation is assessed only against the version of a practice that existed at that conversation's time, so a practice never faults conversations that predate it), and the judge may take the engineer's setup (established practices, rules, conventions, the targeted cloud) into account as expected behavior, with whether that setup is baked into the judge or queried at judge time left open, and harness- and model-agnostic either way.

## Open questions
- The cross-conversation read layer's wire shapes and surfaces (command vs skill) are unbuilt; its direction is captured above and proposed as its own ADR.
- Baked-in vs queried-at-judge-time setup for the practice-adherence check, plus the temporal provenance a time-scoped check needs, are open and decided when that read is built.
- Per-conversation judge enrichments the read would benefit from, deferred to the per-conversation judge (ADR-0008's rubric), not this work: distinguishing "the AI fell short" from "the session was never engaged" so a non-accomplished verdict carries real signal (today's Outcome is a coarse four-value ordinal, abandoned < partial < accomplished-with-correction < accomplished-cleanly, two of them non-accomplished and indistinguishable as to cause); richer per-label criteria; and a friction/effort axis distinct from accomplishment.
- Automatic/proactive triggering is deferred.
- Confirm `ANTHROPIC_MODEL` is not overriding the Opus default on the Mac.
- Batch-size default (10) is a starting guess, tunable after first real use.
