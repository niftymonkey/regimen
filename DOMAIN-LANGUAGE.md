# Domain language

> A shared glossary for Regimen. Terms meaningful to someone who knows the domain but not the code. Definitions only: design decisions live in ADRs and design docs, not here.

## Assignment

The unit of work within a conversation: a coherent, bounded piece of work the engineer asked the AI for. The judgment layer segments a conversation into assignments and classifies each by kind (refactor, debugging, test writing, and so on). Assignments roll up by kind across conversations, letting an engineer see how a given kind of work has gone over many sessions. A kind is an adjective on the unit (a "refactor assignment"); "task" is never a schema term, only casual speech.

## Conversation

The top-level object Regimen measures: one engineer-and-AI-agent session, identified by the harness's session id, considered from its start to wherever it stands now. A conversation is never required to have ended. An open, compacted, or long-running conversation is measured the same way as a finished one.

## Enforcement

One of Regimen's three instruments. Any mechanism that makes an outcome deterministic, not left to the model's discretion: hooks, permission and tool gating, deterministic automation in place of the model, CI and pre-merge gates, sandboxing, schema-constrained outputs, workflow gates. Guidance asks; Enforcement removes the choice. Which techniques are available varies by harness, so Enforcement names the category, and its concrete techniques are realized at the capture/adapter edge.

## Evidence layer

The always-on, inspectable record of what factually happened in a conversation: what was asked, what the agent did, what errors occurred, what the engineer said, and the plain counts over those facts. Available at any time, with no AI evaluation required.

## Feedback

One of Regimen's three instruments. The evidence layer and the judgment layer together: how Regimen shows how well the AI is performing and where the interaction is weak. Feedback observes the interaction, and also produces forward-looking recommendations, such as which kinds of task to route where.

## Guidance

One of Regimen's three instruments. Advisory artifacts, primarily skills, that encode good practice the agent is asked to follow. Guidance instructs; the model may or may not comply.

## Instrument

A pluggable tool Regimen adds to the engineer-and-AI interaction to embody part of the interaction discipline. An engineer adopts instruments individually, as felt needs arise, without adopting a methodology wholesale. An instrument is an addition to the interaction, as opposed to a property the interaction already has (such as the AI's context). Regimen has three instruments: Guidance, Enforcement, and Feedback.

## Interaction discipline

The object Regimen exists to improve: the practice of operating an engineer-and-AI-agent pair to produce good software. Not the engineer alone and not the AI alone, but the discipline of the interaction between them.

## Judgment layer

The assessment an LLM-as-judge produces by reading the evidence layer: structured, named, drill-able signals and the higher-level assessment built from them. The judgment layer shows its work; its conclusions trace back to visible evidence.

## Long arc

The slow feedback loop, operating across many conversations. Rolled-up Feedback reveals a pattern in how a kind of assignment has gone over time, and the engineer responds with a durable change to the instruments themselves: a new or sharpened skill, a new hook, a routing change. The long arc improves the kit.

## Signal

A named, inspectable value surfaced by Regimen, whether computed deterministically (a count) or by the judgment layer (a categorization). Every signal is visible and can be drilled into, regardless of how it was produced.

## Tight loop

The fast feedback loop, operating within a conversation or assignment. The engineer works, Feedback surfaces how it is going, and the engineer adjusts the next assignment by self-correcting or applying an instrument they already have. The tight loop uses the existing kit; it changes behavior, not setup.
