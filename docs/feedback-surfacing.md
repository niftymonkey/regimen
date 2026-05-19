# What Feedback surfaces

Feedback, the Regimen instrument that adds observability to your work with an AI, describes what actually happened, not whether it was right. It reads the factual record of the interaction: what you asked, what the agent did, what broke, and what you said back. Half of what Feedback surfaces is plain counting and holds no opinion; the other half, where an LLM interprets that record, stays anchored to those counts and shows its work, so every signal traces back to evidence you can see. Whether a result was sound is taken from your own reaction to it, never from Feedback grading your code.

*Feedback is one of Regimen's three instruments; see [`regimen-shape.md`](regimen-shape.md) for the whole.*

## The rule: activity is not feedback

A surface of counts and rates ("927 events", "47% Bash", a tool-mix breakdown) is all true and close to useless. An engineer cannot act on an aggregate count. The gap between "here is what happened" and "here is how it went, and what to change" is the entire job of Feedback. Two failures open that gap:

1. **Aggregate-first instead of conversation-first.** The unit an engineer reflects on is a single conversation, and the assignments within it. Aggregates are context, not the object.
2. **Numbers without baselines.** "34 prompts" means nothing until it sits beside "your median is 5". A number becomes a signal only in comparison.

## What Feedback must let an engineer do

Every assignment is the AI doing something the engineer asked for, so the question Feedback answers about it has two parts, and neither is binary: did the AI accomplish the assignment, and how much steering did that take. An assignment lands somewhere on a spectrum, from accomplished cleanly, through accomplished only under heavy correction, to partially done, to abandoned.

After a stretch of work, an engineer can then answer:

- Which assignments were not accomplished cleanly, whether the AI fell short of the goal or reached it only under heavy steering, so I know what to reflect on.
- Where on that spectrum each landed, and why: the steering, tool thrash, long stalls, drift.
- Within a conversation worth a closer look, where it turned: the timeline.
- Across weeks, whether assignments are trending toward clean accomplishment: the long arc.

The first three are the tight loop. The fourth is the long arc. Feedback serves the tight loop first.

## Principles

1. **Conversation-first.** The conversation is the primary object, the assignment the unit within it. A list sorted so the conversations worth reflecting on rise to the top is the home view. Aggregates shrink to a context strip.
2. **Comparative.** Every surfaced number carries a baseline: this conversation against your median, this week against last.
3. **Quality over volume.** Surface where assignments did not land cleanly, not how much happened.
4. **Actionable.** Each surfaced signal maps to a reflection or a lever the engineer can pull. A signal that implies no action is noise.
5. **Both layers visible.** The evidence layer and the judgment layer are both on the surface, and the judge shows its work, so the engineer can check a verdict against the evidence behind it.

## The signals

Feedback's signals come in two layers. The evidence layer is deterministic: exact counts and facts, no AI. The judgment layer is an LLM-as-judge reading the same record.

### Evidence layer

Surfaced as feedback:

- **Staleness**: how long a conversation has been open and how idle it has gone, as a state (active, stalling, abandoned, cleanly ended) and as a trend over time.
- **Compaction count**: how often context was compacted, a sign of context strain. Availability varies by harness.
- **Tool errors**: failed tool calls.
- **Repeated-file edits**: churn on the same file.
- **Instruments in use**: how often each Guidance skill was invoked and each Enforcement mechanism fired. Surfaced as feedback, and also used to anchor the judgment layer's what-helped signal.

Captured but not surfaced. These deterministic counts exist to anchor the judged signals and keep them bounded, not as feedback in themselves: prompt count, tool-call count, tool mix, distinct files touched, edit volume.

Every signal is grouped by **model**, the dimension that lets a single model be assessed on its own terms.

### Judgment layer

The judge first performs **assignment segmentation**, dividing a conversation into its assignments. That is structural, not a surfaced signal, but it makes assignments queryable objects.

Per assignment:

- **Kind**: the type of work (refactor, bug fix, feature, test writing, exploration, and so on). Also a dimension signals roll up by.
- **Outcome**: where the assignment landed on the spectrum, from accomplished cleanly, through accomplished under heavy correction, to partial, to abandoned. The headline.
- **Correction rate**: the share of the engineer's prompts that redirected or overrode the AI.
- **Correction types**: what the corrections were about (misunderstood goal, wrong approach, scope drift, quality, and so on).
- **Prompt clarity**: the quality of the engineer's instructions, the cause-side counterpart to corrections.
- **Drift**: where the model went off-spec.
- **Struggle**: where the model could not get there, repeated failure or thrash.
- **Expressed dissatisfaction**: where the engineer signalled the result was wrong.
- **Silent acceptance**: where the engineer accepted output with no scrutiny.

Across assignments:

- **What-helped**: a skill or hook that visibly improved a trajectory.
- **Skill-gap**: recurring manual work that suggests an instrument should exist but does not.

The judge also produces **the per-conversation assessment**, a readable synthesis of a conversation's signals, and **routing recommendations**: which model or harness suits which kind of work, and what to stop delegating.

### Throughout

Every signal is scoped to an assignment or a conversation and rolls up longitudinally, as trends, per-kind rollups, and your own baselines, so a number becomes comparative. Every signal can be sliced by model, harness, and kind. Feedback never grades software quality, and the judge reads the engineer's inputs and the AI's actions, never the model's private reasoning.

## Surfaces

Three, for when Feedback's surface is built:

- **Overview.** The conversation list, ordered so the conversations worth reflecting on rise first, with a small health strip and recent-character panels such as tool mix. The triage view.
- **Conversation.** The drill-in: the event timeline, this conversation against your median, tool mix, your steering points, the assignments and their kinds.
- **Trends.** The long arc. Deferred until there are weeks of history; a short window only makes it look broken.
