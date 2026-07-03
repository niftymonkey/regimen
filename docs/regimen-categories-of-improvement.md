# Regimen's Categories of Improvement

> The precise problem-space model of what Regimen helps a person improve about working with an AI coding agent. Each category names the actor it concerns, the action it drives, and its time horizon; anything that drives no action is dropped. This is the rigorous companion to [what-regimen-helps-you-with.md](what-regimen-helps-you-with.md) (the user-facing distillation) and the driver used to test Regimen's judged-signal taxonomy: any outcome taxonomy of signals must cover every category here.

## The frame

The object Regimen improves is the interaction discipline: the practice of operating an engineer-and-AI-agent pair to produce good software. Not the engineer alone, not the AI alone. Regimen measures the interaction (the engineer's inputs and the AI's actions), never the quality of the code and never the person.

The set is derived top-down from that purpose and from lived experience of what goes wrong, not by mapping onto Regimen's existing signals or any proposed taxonomy. The real-need filter governs membership: a category earns its place only if surfacing it changes what the engineer does. A true observation that drives no action is noise, not a category.

Every artifact here holds for any agent CLI and any model; harness-specific detail lives only at the capture edge.

## The categories

Four. Three of them are the live arc of a single interaction, set it up, run it, receive what comes back. The fourth is the durable kit you build around all of it.

A live-arc shortfall can be fixed two ways: in the moment (change the behavior next time) or durably (build a lever so the good behavior is automatic). The durable path turns a Framing, Conducting, or Verification finding into a Leverage action; that is the bridge from the tight loop to the long arc.

### 1. Framing (set up)

The engineer's live input to the work: how the goal, scope, and context are stated and supplied at the outset.

- **Actor:** the engineer's own process.
- **Action:** state it more clearly next time, or build or adopt a lever that front-loads that clarity.
- **Horizon:** the tight loop (in the moment).
- **Tone guard:** surfaced only as a specific pattern anchored to what happened, paired with a fix; never a trait verdict, never "you are bad at prompting."

### 2. Conducting (run)

How the engineer runs the work while it is happening: decomposition, delegation and fan-out, how much autonomy a run is granted, when to intervene, when to cut losses and reset context.

- **Actor:** the engineer's own process (execution shape and tempo, distinct from goal content).
- **Action:** decompose differently, delegate or fan out (or stop doing so), grant less or more autonomy, interrupt earlier, reset now.
- **Horizon:** the tight loop (in the moment).

### 3. Verification (receive)

How the engineer receives, checks, and decides on what the AI returns before accepting it.

- **Actor:** the engineer's own process (the intake and judgment side).
- **Action:** actually check before accepting (run it, read the diff, challenge a specific claim), or build a verification lever where the check is mechanizable.
- **Horizon:** the tight loop (in the moment); chronic over-trust or under-trust also reads as a trend.
- **Tone guard:** surfaced as a factual interaction property ("no check occurred between the AI's change and your accept"), never a verdict on the code's correctness or on the person. This is the introspection-resistant category: an engineer cannot notice a check they never made, so it is the one their own reflection structurally cannot surface.

### 4. Leverage (the durable kit)

The durable setup the engineer builds around the work: skills, standing instructions, hooks, sub-agent patterns. Its unique job among the categories is maintaining the levers you already have; building a new one is largely durablizing a recurring in-moment finding (a Framing, Conducting, or Verification pattern), which is the time-range lens acting as the bridge from the tight loop to the long arc.

- **Actor:** the engineer as kit-owner.
- **Actions:** acquire (build or adopt a missing lever), fix (an idle, ignored, or too-costly one), retire (a dead or net-negative one). Whether you acquire by authoring or by adopting an existing standard lever is a downstream choice made by availability, not a distinct action; for a beginner, Regimen can note that a standard one likely exists and need not be authored.
- **Two axes of the read:** liveness (missing, idle, dead, working) and cost (net-positive, net-negative). Liveness alone reaches from "acquire the missing" through "retire the dead"; only the cost axis reaches "retire or loosen a lever that works but costs more than it saves." The positive end of liveness, "working" or "validated," is itself a first-class read: it is where "what is actually helping" and "did the change I made earn its keep" land, even though a healthy lever prompts no action.
- **Two scopes of the read:** the single lever, and the whole kit. The kit scope is where individually-healthy levers are found collectively wrong (two that conflict, are redundant, or are hidden-coupled). That is diagnostic granularity, not new actions: the fixes remain fix and retire, applied with cross-lever context.
- **Horizon:** the long arc (over many conversations).

## The diagnostic (not a category): Attribution

When work went worse than it should have, attribution answers why: the framing, the AI itself, or the environment and tooling. It is the step before improving, not a thing improved.

It does three jobs: it routes the shortfall to the category that can act on it; it scopes the options actually available (when the cause is the environment and the engineer has only one harness, moving is off the table, so the option narrows to working around it or accepting it); and it protects the engineer from misplaced blame, because a well-run session flubbed by the model or the environment is explicitly not the engineer's fault.

It also carries a cost-aware note: a session can be a real, well-run task that still cost more to steer than it was worth, which points at not delegating that class of work rather than at any fix. This absorbs the "was it worth doing this way" question, which is a read on cost, not a separate category.

You do not improve attribution; you use it to pick the fix.

## The gate (not a category): was there a real task

A conversation with no genuine assignment cannot fall short of a potential it never had. The gate screens those out before attribution runs, so exploration and thinking-out-loud are never counted as failures.

## Two lenses (over everything, not categories)

- **Time-range:** every read has a single-conversation form and an across-many-conversations form. The trend, including "did the change I made help" and "is this recurring problem actually as frequent as it feels," is the over-time reading of the categories, not a separate category.
- **Harness and model:** every read can be sliced by which harness and model, so the engineer can see what holds and what breaks when they move. For an engineer with alternatives, this lens can inform a placement move; for one without, it simply reports how their single setup is doing.

## The boundary

Regimen surfaces understanding, as far as naming the shape of a fix and offering to help build it. It never takes the move. The engineer decides and acts.

## Deliberately excluded, and why (the filter at work)

- **Placement** (choosing a different harness or model for a class of work) is not a category: it assumes the engineer has an alternative, which is not universal. It survives as a conditional action informed by the harness/model lens.
- **The AI's behavior** is not a category: the engineer cannot tune the model, only their response to it (Conducting, Verification, or Leverage), so it is a cause observed under attribution, never a thing improved.
- **Skill atrophy** (the engineer's own competence eroding) and **affective degradation** (frustration bleeding into the interaction) are real and documented, but surfacing either requires a verdict on the person, which Regimen does not render. Out of bounds by design.
- **Evidence-layer counts** (prompt and tool counts, tool mix, churn, tool-thrash, stalls, non-convergence) are anchors that feed the categories and the diagnostic. They are not themselves categories of improvement.

## How this feeds back

This set is the driver for the judged-signal taxonomy. Test the current outcome taxonomy ([../plans/judge-outcome-taxonomy-review.md](../plans/judge-outcome-taxonomy-review.md)) against it: does every category here have a home in the taxonomy's signals? The likely gaps to resolve are Verification (no signal today captures whether the engineer checked what came back) and Attribution (which the taxonomy review left unresolved, and which this set places as a diagnostic that routes, not a peer signal). Where the taxonomy does not cover a category, redo the taxonomy driven by the full set rather than patching the edges.
