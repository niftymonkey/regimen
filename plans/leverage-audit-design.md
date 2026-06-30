# Leverage audit (Track 2): detailed design

> Status: design seed (2026-06-29). The detailed design behind capability 2 of ADR-0016 (Reading across conversations is two co-equal capabilities). Seeded verbatim from the engineer's specification. Capability 1, the co-equal verdict rollup, has its own detailed design in plans/verdict-rollup-design.md.

Capability 2: the leverage audit (co-equal with the verdict rollup).

Where the verdict rollup aggregates how conversations went, the leverage audit asks whether the engineer's own established practices (rules, conventions, and skills) are actually honored across conversations. It treats those practices as expected behaviors, measures adherence against the conversation record, and recommends a remedy where one is not being honored. It is time-scoped: a practice has a creation and iteration history, and a conversation is assessed only against the version of a practice that existed at that conversation's timestamp.

The reason this is necessary, and distinct from the rollup, is the unpredictability of model-invoked behavior. A practice expressed as a model-invoked skill (one the agent is meant to invoke on its own) carries a standing cost: the model may simply not invoke it, even when appropriate. A user-invoked practice the engineer triggers explicitly trades that unpredictability for cognitive load on the engineer. The leverage audit is the evaluation that makes a model-invoked practice safe to rely on: it detects silent non-firing that no per-conversation verdict surfaces, because the work still completes and the conversation scores as accomplished. This framing, and the model-invoked versus user-invoked distinction with its context-load versus cognitive-load tradeoff, is drawn from Matt Pocock's "The Missing Manual: How to Write Great Skills."

When a practice is found unhonored, the audit recommends one of four remedies:
- Enforce: convert it to a hard gate the harness cannot bypass. Appropriate for safety rules.
- Revise: rewrite the trigger so it fires. The concrete technique is leading words (Pocock): dense, repeated terms in the skill text that the agent echoes in its reasoning traces. The echo is itself an evidence-layer signal, so the audit can confirm a revision took by detecting whether the new leading word starts appearing in traces, closing the loop between changing a practice and verifying the change worked.
- Convert to user-invoked: stop relying on auto-invocation and require explicit invocation. The right move when a model-invoked practice will not fire reliably and removing the unpredictability beats forcing or rewriting it. (Pocock's own default.)
- Retire: remove it. The test is the catalog-level no-op (Pocock's deletion test): a practice never invoked, whose absence changes nothing, is dead weight.

Detecting silent non-use requires the evidence layer (who initiated an action, which skills fired, whether an applicable practice was present) plus a judge handed the practice's own definition as the rubric. This is a different and stronger input than the rollup's prose, which only surfaces practices the engineer already voiced or that errored loudly.

References: Matt Pocock, "The Missing Manual: How to Write Great Skills," https://www.youtube.com/watch?v=UNzCG3lw6O0 (model-invoked versus user-invoked skills; context load versus cognitive load; leading words; the no-op deletion test).
