# What Feedback surfaces

> How Feedback must communicate, and what that demands of what it captures. Part of the Regimen program; see `regimen-shape.md` for the whole.

## The rule: activity is not feedback

A surface of counts and rates ("927 events", "47% Bash", a tool-mix breakdown) is all true and close to useless. An engineer cannot act on an aggregate count. The gap between "here is what happened" and "here is how it went, and what to change" is the entire job of Feedback. Two failures open that gap:

1. **Aggregate-first instead of conversation-first.** The unit an engineer reflects on is a single conversation, and the assignments within it. Aggregates are context, not the object.
2. **Numbers without baselines.** "34 prompts" means nothing until it sits beside "your median is 5". A number becomes a signal only in comparison.

## What Feedback must let an engineer do

Feedback exists so an engineer can answer, after a stretch of work:

- Which of my conversations went badly, so I know what to reflect on.
- What "badly" looked like: where the friction was, high steering, tool thrash, long stalls, drift, abandoned work.
- In a bad conversation, where it went wrong: the timeline.
- Across weeks, whether it is improving: the trend.

The first three are the tight loop. The fourth is the long arc. Feedback serves the tight loop first.

## Principles

1. **Conversation-first.** The conversation is the primary object, the assignment the unit within it. A list sorted so rough conversations surface is the home view. Aggregates shrink to a context strip.
2. **Comparative.** Every surfaced number carries a baseline: this conversation against your median, this week against last.
3. **Quality over volume.** Surface which conversations went badly, not how much happened.
4. **Actionable.** Each surfaced signal maps to a reflection or a lever the engineer can pull. A signal that implies no action is noise.
5. **Both layers visible.** The evidence layer and the judgment layer are both on the surface, and the judge shows its work, so the engineer can check a verdict against the evidence behind it.

## What this demands of what Feedback captures

Work backward from the surface: to surface something, capture what it needs.

| To surface | What capture must provide |
|---|---|
| Conversation duration and shape | the conversation's start, its run of events, and its current end, with never-ended conversations evaluated start-to-now |
| Steering load | the engineer's prompts, and the judgment layer's read of which were corrections |
| Tool thrash and tool mix | tool calls with tool name, and repeated edits to the same file |
| Thinking vs doing | event timing across a conversation; the gaps between events are model inference |
| Per-model views | the model recorded for each event |
| Assignments and their kinds | the judgment layer's segmentation of a conversation into assignments |
| Correction rate, drift, outcome | judgment-layer signals, read from the captured conversation |

The surfaced signals are chosen as the columns of the conversation list, not picked abstractly: duration, tool calls, prompts, thinking-vs-doing, assignment outcomes. Signals and surface are designed together.

## Surfaces

Three, for when Feedback's surface is built:

- **Overview.** The conversation list with rough conversations surfaced, a small health strip, and recent-character panels such as tool mix and a length histogram. The triage view.
- **Conversation.** The drill-in: the event timeline, this conversation against your median, tool mix, thinking-vs-doing, your steering points, the assignments and their kinds.
- **Trends.** The long arc. Deferred until there are weeks of history; a short window only makes it look broken.

The conversation list is a table designed to gain columns. As the judgment layer matures it gains a model column, an assignment-kind column, an outcome column. New capability fills placeholders and adds columns; it does not force a redesign.
