# Domain language

> A shared glossary for Regimen. Terms meaningful to someone who knows the domain but not the code. Definitions only: design decisions live in ADRs and design docs, not here.

## Anchor

A deterministic event from the evidence layer that the judgment layer points at when making a claim. Every judged signal cross-references one or more anchors so a verdict is checkable against the evidence behind it. Anchors keep the judge falsifiable.

## Assignment

The unit of work within a conversation: a coherent, bounded piece of work the engineer asked the AI for. The judgment layer segments a conversation into assignments and classifies each by intent (see Intent). Assignments roll up by intent across conversations, letting an engineer see how a given intent of work has gone over many sessions. "Task" is never a schema term, only casual speech.

## Conversation

The top-level object Regimen measures: one engineer-and-AI-agent session, identified by the harness's session id, considered from its start to wherever it stands now. A conversation is never required to have ended. An open, compacted, or long-running conversation is measured the same way as a finished one.

## Enforcement

One of Regimen's two lever instruments (with Guidance), acted with in response to what Feedback surfaces. Any mechanism that makes an outcome deterministic, not left to the model's discretion: hooks, permission and tool gating, deterministic automation in place of the model, CI and pre-merge gates, sandboxing, schema-constrained outputs, workflow gates. Guidance asks; Enforcement removes the choice. Which techniques are available varies by harness, so Enforcement names the category, and its concrete techniques are realized at the capture/adapter edge.

## Evidence layer

The always-on, inspectable record of what factually happened in a conversation: what was asked, what the agent did, what errors occurred, what the engineer said, and the plain counts over those facts. Available at any time, with no AI evaluation required.

## Feedback

Regimen's central instrument, the observability. The evidence layer and the judgment layer together, turning the engineer's felt sense of how the AI is performing into data: how well the AI is performing, and where the interaction is weak. Feedback observes the interaction; the levers, Guidance and Enforcement, are what the engineer acts with in response to it (ADR-0013). It is also designed to produce forward-looking recommendations, such as which intents of work to route where (a planned extension, not yet built).

## Guidance

One of Regimen's two lever instruments (with Enforcement), acted with in response to what Feedback surfaces. Any advisory artifact the agent is asked to use, not compelled: skills, standing instructions (`CLAUDE.md` / `AGENTS.md`), an MCP server or CLI it can use, and more. Guidance asks, the model may or may not comply; Enforcement removes the choice. Like Enforcement, Guidance names the category, and its concrete forms are realized at the capture/adapter edge and vary by harness and engineer.

## Harness

The agent CLI an engineer uses to interact with their AI agent: Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Copilot, and so on. Regimen's harness-agnostic design means every artifact (schemas, signals, interfaces, configs) must hold across harnesses; the only harness-specific code is a small adapter at the capture edge per harness.

## Instrument

A pluggable tool Regimen adds to the engineer-and-AI interaction to embody part of the interaction discipline. An engineer adds the levers individually, as felt needs arise, without adopting a methodology wholesale; Feedback is the always-on center, not one more piece adopted individually. An instrument is an addition to the interaction, as opposed to a property the interaction already has (such as the AI's context). Regimen's instruments are not co-equal: Feedback is the center (the observability), and Guidance and Enforcement are the levers acted with in response to what Feedback surfaces (ADR-0013). The set of levers is open, not fixed at two (ADR-0001).

## Intent

The engineer's categorical purpose for an assignment: refactor, bug-fix, feature, test-writing, exploration, schema-change, and similar. One of the dimensions the judgment layer derives, and a dimension signals roll up by. Intent names what the engineer was trying to do, not what code changed.

## Interaction discipline

The object Regimen exists to improve: the practice of operating an engineer-and-AI-agent pair to produce good software. Not the engineer alone and not the AI alone, but the discipline of the interaction between them.

## Judgment layer

The assessment an LLM-as-judge produces by reading the evidence layer: structured, named, drill-able signals and the higher-level assessment built from them. The judgment layer shows its work; its conclusions trace back to visible evidence.

## Kit

The set of levers the engineer has adopted at a given point in time (Guidance skills and Enforcement gates), with Feedback as the always-on center that observes them. The long arc improves the kit: rolled-up patterns drive durable changes like adding a Guidance skill, sharpening an existing one, adding an Enforcement gate, or changing a routing. The tight loop uses the existing kit; it changes behavior, not the kit.

## Long arc

The slow feedback loop, operating across many conversations. Rolled-up Feedback reveals a pattern in how an intent of work has gone over time, and the engineer responds with a durable change to the kit: a new or sharpened skill, a new gate, a routing change. The long arc improves the kit.

## Outcome

The headline judged signal for an assignment: an ordinal verdict on how the work went, from accomplished-cleanly (best), through accomplished-with-correction and partial, to abandoned (worst). Scored on whether the agent did what the engineer wanted and how much correction that took, never on software quality or transcript length (ADR-0003, ADR-0008). "Did the agent do what I wanted, and how much correction did that take" is the core question Feedback answers, and it is the Intent plus Outcome read.

## Respond step

The third part of the long arc, where a diagnosed pattern is turned into a durable change to the kit. Regimen is designed to offer light assistance here (surfacing the pattern in plain language and suggesting what to research, build, or invoke); this respond-step assistance is not yet built. The engineer does the authoring.

## Signal

A named, inspectable value surfaced by Regimen, whether computed deterministically (a count) or by the judgment layer (a categorization). Every signal is visible and can be drilled into, regardless of how it was produced.

## Tight loop

The fast feedback loop, operating within a conversation or assignment. The engineer works, Feedback surfaces how it is going, and the engineer adjusts the next assignment by self-correcting or applying an instrument they already have. The tight loop uses the existing kit; it changes behavior, not setup.
