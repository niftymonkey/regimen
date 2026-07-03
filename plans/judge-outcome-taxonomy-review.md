# Judge Outcome taxonomy: first-principles review (decision)

> Read-only analysis, 2026-06-30. Reopens the locked ADR-0008 Outcome ordinal at the engineer's explicit invitation. Method: the brainstorming skill run autonomously, sourcing intent from the documented record (mental-model.md, feedback-surfacing.md, ADR-0003/0008/0016, the just-built rubric enrichment) and from the live judged store (29 judged conversations of 227 captured). No code changed, no store mutated, no model budget spent.

## The decision (up front)

Replace the single four-value diagonal ordinal (`abandoned < partial < accomplished-with-correction < accomplished-cleanly`) with TWO orthogonal ordinal axes that recover the two parts feedback-surfacing.md says the Outcome question "has," then never lets be read apart:

- Accomplishment (ordinal): `not-accomplished < partial < accomplished`. Did the AI meet the engineer's stated intent. Owns done-ness only.
- Correction-cost (ordinal): `none < light < heavy`. How much corrective steering the result took. Owns steering only. The `light` versus `heavy` split is the lower-confidence half, anchored by the deterministic correction-rate; it degrades cleanly to a binary `none < corrected` if the judge cannot apply three values reliably.

Outcome stays an ordinal: it is now ordinal on BOTH axes, and the single spectrum that trending, triage, and the rollup read is DERIVED deterministically from the pair (worst to best: `not-accomplished` < `partial` < `accomplished+heavy` < `accomplished+light` < `accomplished+none`), so the load-bearing-spectrum property ADR-0008 leaned on is preserved as a read-time derivation instead of a stored conflation. Engagement (`engaged | not-engaged`) stays a separate orthogonal signal: the data validates it as genuinely orthogonal, but its rubric wording needs one fix. The parked friction/effort axis stays parked and stays distinct from correction-cost (grind by the AI versus redirection by the engineer).

This OVERTURNS ADR-0008's "Outcome is a single ordinal" and the one sentence in feedback-surfacing.md that collapses the two parts into one spectrum. It KEEPS everything else ADR-0008 decided (the generic signal row, anchors, run-supersede, prose-before-label, no software-quality grading). The strongest cheaper alternative (re-anchor the existing single ordinal in place) is documented below; choose it if the read-surface churn is not worth paying even at a moment when a full re-judge is already scheduled.

## Why this is the moment, and why it is cheap

The enrichment plan (plans/judge-prompt-setup-and-rubric-design.md) is about to run `regimen assess --all --force` over the whole corpus to re-judge against the enriched rubric. A re-judge is the only thing that "migrates" judged values, and it is already going to happen. So the marginal cost of fixing the taxonomy now is the read-surface change plus an ADR amendment, not a separate re-sweep. Fixing values around a taxonomy and then re-sweeping, without revalidating the taxonomy, spends the expensive re-judge on the wrong target. This review exists to avoid exactly that.

## What an Outcome is FOR (derivation, step 1)

Across mental-model.md and feedback-surfacing.md the Outcome value has one job stated three ways:

- The core measurable unit is "did the agent do what I wanted, and how much correction did that take?" (mental-model.md section 4). Note the AND: it is explicitly two questions.
- feedback-surfacing.md, "What Feedback must let an engineer do": "the question Feedback answers about it has two parts, and neither is binary: did the AI accomplish the assignment, and how much steering did that take." Then, in the very next sentence, it projects those two parts onto one line: "an assignment lands somewhere on a spectrum, from accomplished cleanly, through accomplished only under heavy correction, to partially done, to abandoned." ADR-0008 adopted that projected line as the stored Outcome.
- The decisions Outcome must drive: (a) the tight-loop in-session read "did this serve me so far?" (the headline Outcome plus assessment); (b) the rollup's worst-to-best distribution ("am I trending toward clean accomplishment"); (c) the triage sort that lifts "conversations worth reflecting on" to the top (Quality-over-volume); (d) the engineer's reflection trigger. The leverage audit reads adherence, not Outcome, but uses an engaged denominator.

A value that drives no decision is dead weight; a decision-relevant distinction that no value captures is a gap. The two-part framing is the requirement. The single ordinal is one possible encoding of it, and the encoding is the thing under review, not the requirement.

## The dimensions of "how a coding session went" (derivation, step 2)

Decomposing "how it went" from the docs and the evidence yields four genuinely independent dimensions, not one:

1. Accomplishment: degree the assignment's intent was met (none / partial / full). A true rank: more done is unambiguously better. Judged from the engineer's stated intent and the AI's actions (ADR-0003 clean).
2. Correction-cost: how much the engineer had to redirect, correct, or repair the AI's course to get there. Also a rank. Judged from the engineer's inputs. This is feedback-surfacing.md's second "part," and it is separately rostered as the deterministic "correction rate" and "correction types" signals.
3. Friction/effort: how grindy the AI's own path was (tool thrash, stalls, repeated-file churn, self-recovery), INDEPENDENT of whether the engineer corrected anything. This is ADR-0016's parked axis. It is distinct from correction-cost: grind can be high with zero engineer corrections (the AI flailed and recovered alone), and correction can be high with low grind (the engineer redirected scope cleanly with no thrash).
4. Engagement: whether the conversation was ever a real work session at all. A gate, not a degree. Orthogonal to all three above.

The current single ordinal smashes dimensions 1 and 2 onto a single diagonal, ignores 3, and (as the evidence shows) leaks into 4 at its bottom. The diagonal is not monotonic in any one dimension: `partial` ranks degree-1 with degree-2 unspecified, while `cleanly` versus `with-correction` ranks degree-2 with degree-1 held at "full." Reading the four as a spectrum therefore silently asks the reader to compare a done-ness drop against a steering increase as if they were the same currency. They are not.

## What the evidence showed (derivation, step 3, and the empirical grounding)

I reached the live judged store (`~/.local/share/regimen/feedback.db`, copied with its WAL to scratch and queried read-only; the live store and daemon were never touched). 227 conversations captured, 29 judged (latest-run-wins). The enriched 2026-06-29 rubric has already been applied to part of the corpus, so engagement is live in the data.

Outcome distribution over the 29 judged conversations:

- `accomplished-with-correction`: 18 (62%)
- `accomplished-cleanly`: 9 (31%)
- `abandoned`: 2 (7%)
- `partial`: 0 (0%)

Engagement crossed with Outcome (the composition the enrichment plan promised):

- `abandoned` co-occurs with `not-engaged` in 2 of 2 cases. There is not one `engaged + abandoned` in the corpus.
- `not-engaged` also appears once with `accomplished-cleanly` (a status-check session the AI answered fine, then the engineer left without bringing a task).
- Every `accomplished-with-correction` that carries an engagement value is `engaged`.

Three findings, in descending evidential strength:

- Finding 1, the correction bucket is where the variance lives, and it is one bit wide. 93% of judged sessions are "accomplished"; the only Outcome distinction the judge draws across them is `cleanly` versus `with-correction`, a single boundary. Reading the `with-correction` prose, that one value spans from "one mechanical sed misfire fixed immediately" to "repeatedly steered across a multi-phase session." The dominant, decision-relevant variation (how much steering) gets one bit, while the near-empty accomplishment floor gets two whole values. The resolution is allocated backwards.
- Finding 2, `abandoned` and `not-engaged` are the same population in practice. Both abandoned verdicts are not-engaged, and the clearest case (session d11e0934) is a smoking gun: the prose says the AI did "real, substantive groundwork ... genuine and competent" on an ambitious design assignment, then a missing-skill blip stalled the deliverable. That is textbook `engaged` and textbook `partial` (meaningful progress, intent unmet). The judge instead returned `abandoned + not-engaged`, both arguably wrong, because the not-engaged rubric lists "a setup blip" and the judge matched "skill-resolution blip" to it. The engagement axis, the very signal added to STOP outcome-cause from contaminating the bottom, is itself being driven by outcome-cause through that one wording. The bottom of the Outcome ordinal and engagement are not cleanly partitioned today.
- Finding 3, `partial` is unused even where it fits. Zero of 29, including the d11e0934 case that fit it best. Either the corpus genuinely lacks partials or the judge avoids the middle. The d11e0934 case proves the avoidance happens at least sometimes.

Honest limitation: n is 29, single engineer, all `claude` sessions, a success-skewed readiness corpus. The accomplishment FLOOR (`partial`, `not-accomplished`) is unexercised, so the data cannot prove those values are wrong; a weaker model or a junior engineer would populate them. My recommendation to keep an accomplishment-degree axis therefore rests on the purpose-derivation and the model-agnostic mandate, NOT on this corpus. What the data DOES prove is Finding 1 (the steering mega-bucket) and Finding 2 (the abandoned/not-engaged conflation). Those two are what move the decision.

## Verdict on the current four values, one at a time

- `accomplished-cleanly`: KEPT, but as a derived combination `accomplished + correction-cost:none`, not a primitive. Reason: "clean accomplishment" is the single most useful and most reliably-judged distinction in the data, so it must survive; but it is a point in the 2D space, not a rank position, and storing it as a primitive is what forced the diagonal.
- `accomplished-with-correction`: REPLACED by `accomplished + correction-cost:{light|heavy}`. Reason: it is a 62% catch-all compressing the corpus's dominant variance into one value. Splitting correction-cost out gives that variance its own axis and its own (deterministic-anchored) resolution, instead of one boundary doing all the work.
- `partial`: KEPT as the middle of the accomplishment axis, with a sharper criterion. Reason: degree-of-accomplishment is a real rank and `partial` is its real middle; the model-agnostic mandate keeps it even though this corpus does not exercise it. Its disuse is a criterion and incentive problem (the judge fled to `abandoned`), addressed by removing the competing bottom value and by stating partial as "meaningful progress, intent unmet" without a steering qualifier.
- `abandoned`: DROPPED as a distinct Outcome value. Reason: the data shows it is not a third degree below partial; it is `not-accomplished` plus a CAUSE, and the cause already has homes. Cause "never a real session" lives in `engagement:not-engaged` (both abandoneds were exactly this). Cause "engaged but blocked" lives in `accomplishment:not-accomplished` plus the assessment prose (and later the friction axis). Keeping `abandoned` as an Outcome value is the structural source of the conflation in Finding 2.
- ADDED: `not-accomplished` as the floor of the accomplishment axis (the cause-free "no working result toward intent"), and the whole `correction-cost` axis (`none < light < heavy`).

## How Outcome, engagement, and friction partition the space (no overlap, no gap)

- Accomplishment (Outcome axis 1): degree the intent was met. Owns done-ness. Composes with engagement to express the old `abandoned`: `not-accomplished + not-engaged` is "never a real attempt," `not-accomplished + engaged` is "the AI failed at real work."
- Correction-cost (Outcome axis 2): how much engineer redirection the result required. Owns steering. Anchored by the deterministic correction-rate; the judged ordinal is the interpretation, the rate is the count, exactly the judged-versus-anchor split ADR-0008 already mandates.
- Engagement (separate signal, conversation-scoped): was this a real work session at all. Owns the gate. Validated as orthogonal by the data (a not-engaged session can be accomplished-cleanly). Requires one wording fix: strike "a setup blip" from the not-engaged definition, because a real assignment derailed by tooling is engaged-and-blocked (an accomplishment and friction fact), not never-engaged.
- Friction/effort (parked, future): how grindy the AI's own path was, independent of engineer correction. Owns grind. Distinct from correction-cost on both directions (high grind with no corrections; high corrections with no grind), which is exactly why it must NOT be folded into axis 2.
- Correction-rate / correction-types (rostered, future): the deterministic count and categorization beneath axis 2.

The cut lines: done-ness is not steering is not real-session is not grind. Every old conflation (abandoned approximately equals not-engaged; cleanly-versus-corrected riding inside the same rank as done-ness) is resolved, and nothing the orthogonal signals are meant to hold is pulled back into Outcome.

## Rejected alternatives

- Keep the four exactly (validate the status quo). Rejected. It fails decision criterion 1: the dominant decision-relevant distinction (steering) gets one bit while two values sit on a near-empty floor, and the floor conflates with engagement (Findings 1 and 2). "They already exist and the rollup reads them" is not a reason; it is the status quo the engineer asked me not to defer to.
- Collapse Outcome to pure accomplishment (`not-accomplished < partial < accomplished`) and push ALL steering to the rostered correction signal. Tempting and clean, and it is the right END state for axis 1. Rejected AS THE WHOLE answer because the correction signal does not exist yet (the store confirms only intent/outcome/engagement are built), so evicting steering today would delete the one distinction the judge reliably produces and defer it to an unbuilt signal, regressing delivered value. Promoting steering to a co-equal Outcome axis keeps it first-class NOW; the rostered correction-rate becomes its deterministic anchor rather than its only home.
- Split `abandoned` into two Outcome values by cause (`never-engaged` versus `ai-blocked`). Rejected. Cause is not a rank, so it breaks the ordinal, and ADR-0008 already rejected this. The cause split is precisely what the orthogonal engagement signal is for; the fix is to let engagement do it, not to re-encode cause in the ordinal.
- A numeric composite quality score. Rejected, same as ADR-0008: fine numeric scales are where an LLM judge goes arbitrary, and they smuggle in software-quality grading that ADR-0003 forbids. Two coarse 3-value ordinals are not a fine scale; each value has a stated criterion and the harder axis (correction-cost) has a deterministic anchor.
- Three axes now (add friction alongside accomplishment and correction-cost immediately). Rejected for now, on YAGNI and reliability. Friction needs its own deterministic anchors (thrash, stalls, churn) wired in before the judge can apply it consistently; it stays parked exactly as ADR-0016 left it. The two-axis split is the change the evidence demands; the third axis is a later, separately-justified addition.

## Migration and reversibility cost (so the engineer can weigh it)

If adopted, the cost is concentrated and most of it is already scheduled:

- ADR-0008 amendment: a new ADR (or an amend block) overturning "Outcome is a single ordinal" and recording the two-axis decision plus the derived-spectrum rule. The generic-row design needs no change; this is values and read-projection, not storage shape.
- Signal vocabulary: replace `outcome`'s value set with the accomplishment set, add a `correction-cost` member to `SignalName` with its own ordinal vocabulary and parser fragment. By ADR-0008 this is "a new member plus its prompt fragment and parser, never an interface change," and the generic writer needs no schema migration. Bump `rubricVersion`.
- Read surface: this is the real cost and it touches what ADR-0008 carefully designed. The in-session digest headline (`digest.ts`) currently derives the headline by `find(signalName === 'outcome')`; it must derive the headline from the pair (or from the derived spectrum). `slice.ts` projects only the `outcome` column for bulk; it must project both axes or the derived rank. The rollup's deterministic header (`rollup.ts`, the built tracer) tallies the Outcome distribution; it must tally the derived spectrum or both axes. None of these are schema changes; all are read-projection changes, each localized.
- Re-judge: a `regimen assess --all --force` sweep. Already planned by the enrichment effort, so this cost is sunk if the two changes ride the same sweep. Existing verdicts re-project losslessly under the derived spectrum (today's `cleanly` maps to `accomplished+none`, `with-correction` to `accomplished+light|heavy`), so nothing is stranded.
- Reversibility: MEDIUM-HIGH. The judge depends on the values through the prompt and parser; the consumers depend through three localized read projections. Reverting to the single ordinal is a prompt-plus-parser change plus re-collapsing the three projections, plus a re-judge. No data is destroyed because the two axes carry strictly more information than the diagonal.

The cheaper fallback, in full, if the read-surface churn is judged not worth paying: keep Outcome a single four-value ordinal but (a) drop `abandoned` in favor of `not-accomplished` so the floor stops naming a cause, (b) strike "a setup blip" from engagement's not-engaged definition to stop the leak, (c) sharpen `partial`, and (d) accept that steering resolution stays one bit until the rostered correction signal is built. This fixes Finding 2 and dents Finding 3 with prompt-only changes and no read-surface or schema impact, but it leaves Finding 1 (the steering mega-bucket) unaddressed until a separate signal lands. It is strictly less faithful to feedback-surfacing.md's two-part framing; it is the right call only if read-surface stability outranks that fidelity right now.

## The single biggest open question for the engineer

Does the steering / correction dimension belong INSIDE Outcome as a co-equal stored axis (the recommendation, which pays a localized read-surface change to give the corpus's dominant variance its own resolution now), or should Outcome reduce to pure accomplishment with steering deferred entirely to the separate rostered correction signal (cheaper in read-surface, but it removes the one distinction the judge reliably makes today until that signal is built)? The corpus (n=29, success-skewed, single harness) cannot settle this; it confirms the steering bucket is too coarse and the abandoned floor conflates with engagement, but it cannot say how much accomplishment-floor or correction-cost resolution a harder corpus needs. That is the judgment call the data underdetermines and the engineer should make.
