# Feedback measures the conversation, not the software

> Status: accepted (2026-05-18)

Feedback measures how well the AI performed the work it was given, never whether the resulting software is good, because software quality is subjective and not Regimen's to adjudicate. The measured object is the conversation, evaluated start-to-now and never waiting on a close, since Regimen conversations routinely never end cleanly. Feedback has two visible layers: an always-on deterministic evidence layer, and an LLM-as-judge judgment layer that emits structured, drill-able signals and shows its work. The unit within a conversation is the assignment, classified by kind and rolled up by kind across conversations.

## Considered options

- Grade software quality. Rejected: subjective, context-bound, not Regimen's to judge.
- An opaque LLM verdict. Rejected: unfalsifiable; the engineer cannot calibrate trust in it or learn from it.
- Require a finished or closed session before evaluating. Rejected: Regimen conversations routinely never end cleanly.

## Consequences

Soundness enters Feedback only through the engineer's own in-conversation reactions, captured as signals, never through Regimen forming its own judgment of the artifact.
