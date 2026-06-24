# What Feedback surfaces

Feedback, the Regimen instrument that adds observability to your work with an AI, describes what actually happened, not whether it was right. It reads the factual record of the interaction: what you asked, what the agent did, what broke, and what you said back. Half of what Feedback surfaces is plain counting and holds no opinion; the other half, where an LLM interprets that record, stays anchored to those counts and shows its work, so every signal traces back to evidence you can see. Whether a result was sound is taken from your own reaction to it, never from Feedback grading your code.

*Feedback is the center of Regimen, the observability that Guidance and Enforcement (the two levers) act in response to; see [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the whole.*

## The rule: activity is not feedback

A surface of counts and rates ("927 events", "47% Bash", a tool-mix breakdown) is all true and close to useless. An engineer cannot act on an aggregate count. The gap between "here is what happened" and "here is how it went, and what to change" is the entire job of Feedback. Two failures open that gap:

1. **Aggregate-first instead of conversation-first.** The unit an engineer reflects on is a single conversation, and the assignments within it. Aggregates are context, not the object.
2. **Counts mistaken for feedback.** A raw count, "34 prompts" or "600 tool calls", describes activity, not how the work went. Counts serve as anchors beneath the real signals; on their own they are not feedback.

## What Feedback must let an engineer do

Every assignment is the AI doing something the engineer asked for, so the question Feedback answers about it has two parts, and neither is binary: did the AI accomplish the assignment, and how much steering did that take. An assignment lands somewhere on a spectrum, from accomplished cleanly, through accomplished only under heavy correction, to partially done, to abandoned.

After a stretch of work, an engineer can then answer:

- Which assignments were not accomplished cleanly, whether the AI fell short of the goal or reached it only under heavy steering, so I know what to reflect on.
- Where on that spectrum each landed, and why: the steering, tool thrash, long stalls, drift.
- Across weeks, whether assignments are trending toward clean accomplishment: the long arc.

The first two are the tight loop. The third is the long arc. Feedback serves the tight loop first.

## Principles

1. **Conversation-first.** The conversation is the primary object, the assignment the unit within it. A list sorted so the conversations worth reflecting on rise to the top is the home view. Aggregates shrink to a context strip.
2. **Comparative.** A single conversation's signals stand on their own, so Feedback is useful from the first one. As history accrues, each signal also gains a baseline, this conversation against your median, this week against last, which sharpens it and makes the long arc legible. Comparison grows with use; it is not a precondition for value.
3. **Quality over volume.** Surface where assignments did not land cleanly, not how much happened.
4. **Actionable.** Each surfaced signal maps to a reflection or a lever the engineer can pull. A signal that implies no action is noise.
5. **Both layers visible.** The evidence layer and the judgment layer are both on the surface, and the judge shows its work, so the engineer can check a verdict against the evidence behind it.
6. **Honest over tidy.** Prefer an honestly-incomplete representation over a tidy false one. A conversation that has not ended renders as open, never as force-closed with an invented end. A signal not yet measured renders as absent, never as a default zero. Fabricating completeness to look orderly poisons the comparative baselines every other principle depends on; absence and in-flight state are themselves information.

## The signals

Feedback's signals are queryable, typed values. They come in two layers: the evidence layer is deterministic, exact counts and facts with no AI; the judgment layer is structured telemetry an LLM-as-judge derives from the same record.

### Evidence layer

Surfaced as feedback:

- **Staleness**: how long a conversation has been open and how idle it has gone, as a state (active, stalling, abandoned, cleanly ended) and as a trend over time.
- **Compaction count**: how often context was compacted, a sign of context strain. Availability varies by harness.
- **Tool errors**: failed tool calls.
- **Repeated-file edits**: churn on the same file.
- **Instruments in use**: how often each Guidance skill was invoked and each Enforcement mechanism fired. Surfaced as feedback, and also used to anchor judged signals.

Captured only as anchors, never shown as feedback; these keep the judged signals bounded: prompt count, tool-call count, tool mix, distinct files touched, and edit volume.

Every signal is grouped by **model**, the dimension that lets a single model be assessed on its own terms.

### Judgment layer

The judge derives these by reading the conversation against a fixed schema and rubric. Each is a typed value, written into the same queryable store as the evidence-layer signals, so a judged signal trends and slices exactly like a counted one, and each is cross-checked against its deterministic anchor.

First, **assignment segmentation** divides a conversation into its assignments. Structural, not a surfaced signal, but it makes assignments queryable objects.

Then, per assignment:

- **Intent**: a categorical value from a fixed vocabulary (refactor, bug-fix, feature, test-writing, exploration, schema-change, and so on). Names what the engineer was trying to do. Also a dimension signals roll up by.
- **Outcome**: an ordinal value from a fixed set (accomplished cleanly, accomplished with correction, partial, abandoned). The headline.
- **Correction rate**: a number, corrections over prompts.
- **Correction types**: a count per category from a fixed vocabulary (misunderstood goal, wrong approach, scope drift, quality, omission, and so on).
- **Prompt clarity**: an ordinal grade from a fixed scale (clear, mixed, unclear).
- **Drift**: a count of incidents, each a structured item, a type tag plus a reference to the event.
- **Struggle**: a count of episodes, each a structured item.
- **Expressed dissatisfaction**: a count, with references to the events.
- **Silent acceptance**: a flag.

The judge also writes prose; see Narrative outputs.

### Throughout

Every signal is scoped to an assignment or a conversation and rolls up longitudinally, as trends, per-intent rollups, and your own baselines once they exist. Every signal can be sliced by model, harness, and intent. Feedback never grades software quality, and the judge reads the engineer's inputs and the AI's actions, never the model's private reasoning.

## Narrative outputs

Beyond the signals, the judge writes prose for an engineer to read, exposed by the CLI. You can ask for it about a single conversation or across a window, the last week or the last month:

- **The assessment**: a readable synthesis of how a conversation, or a stretch of work, went.
- **What-helped**: a skill, hook, or intervention that visibly improved a trajectory.
- **Skill-gap**: recurring manual work that suggests an instrument should exist but does not.
- **Routing recommendations**: which model or harness suits which intent of work, and what to stop delegating.

Asked across a window, what-helped, skill-gap, and routing aggregate: "eleven conversations this week would have benefited from the same missing skill." These outputs are understanding, not metrics; they never enter the signal store.

## Surfaces

Three, for when Feedback's surface is built:

- **Overview.** The conversation list, ordered so the conversations worth reflecting on rise first, with a small health strip and recent-character panels such as tool mix. The triage view.
- **Conversation.** The drill-in: the event timeline, this conversation against your median, tool mix, your steering points, the assignments and their intents.
- **Trends.** The long arc. Deferred until there are weeks of history; a short window only makes it look broken.
