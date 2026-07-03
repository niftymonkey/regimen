# Finish line: Regimen becomes a tool in use, not a project

> Active driver, started 2026-07-03. Supersedes plans/four-harness-evaluation-readiness.md (closed same day). This document is DONE when every unit below is landed or explicitly ticketed, at which point Regimen has no in-flight work.

## What done means

The engineer can start a conversation in any harness and ask plain questions ("how have my sessions gone this week", "is one harness or model doing better than the rest", "why is this session such a slog") and get good, evidence-anchored answers; assessments happen when it makes sense because the tool prompts for them; none of it requires special inference setup beyond what the engineer already has.

## Scope decisions (2026-07-03)

- Core loop + polish only. Dropped by decision: per-OS acceptance runs (OS gaps become bug tickets), Grafana/longitudinal telemetry, assignment segmentation (#22), Workstream 2 (company-eval rubric pass), proactive unprompted pattern surfacing (#24 closes as satisfied-by-rollup).
- Run mode: autonomous off-thread TDD units, CodeRabbit-clean, agents commit locally on branches; the engineer gates every merge and push, and the metered re-sweep. Model tiers: Opus for hard implementation, Sonnet for research/docs/small fixes, Fable for orchestration and design-coupled units.

## Stage 1: land the in-flight branch (IN PROGRESS)

`feat/judge-prompt-setup-rubric` carries the 8 judge-prompt enrichment commits plus 6 landing commits (ADR-0017 adopted, six OQs stamped resolved, all design/provenance docs committed, rollup tracer committed, old driver closed). Checks green (feedback 617/0), CodeRabbit clean on the branch diff. AWAITING: engineer gate to push + PR + merge. After merge: delete the branch, everything proceeds from clean main.

## Lane A: the feedback heart (critical path, in order)

- A1. Taxonomy build: execute the 6-step sequence in docs/judged-taxonomy-redesign.md section 8.1 (new signals framing/conducting/verification/effort/convention-adherence, attribution diagnostic, accomplishment + correction-cost with derived outcome, engagement wording fix, conversation_setup_snapshot migration, reliability gate: sample-validate on 5-10 real conversations, degrade or defer mis-firing signals). Short-lived branches off main, one PR per step or sensible grouping. Opus builders.
- A2. Judge backend generalization: OpenRouter adapter (key + engineer-chosen model, free models viable) alongside the Anthropic HTTP and Claude CLI adapters; default = external key when present, else Claude CLI, else agent-driven (A3); env-var config, vendor-agnostic. Design pass first (new boundary), then build. Curated judge-model list is roadmap, not this push.
- A3. Agent-driven judging (the no-key path for all four harnesses): a deterministic seam (assess --emit-prompt / --record-verdict shape) so the current conversation's agent produces the verdict with the standard prompt and persists it through the normal store path. Satisfies issue #25. Design pass shared with A2.
- A4. Corpus re-sweep: `regimen assess --all --force` under the new taxonomy. Metered model spend; engineer gates with a count + cost estimate first. Requires A1; benefits from A2.
- A5. Verdict rollup (ADR-0016 capability 1): productionize the rollup header tracer + collectVerdicts + the model-driven patterns-and-remedies narrative per plans/verdict-rollup-design.md; delete packages/feedback/prototypes/ and their ignore entries. Requires A4.
- A6. Leverage audit (ADR-0016 capability 2): practice-adherence read with enforce/revise/convert/retire recommendations, time-scoped to the practice version in force, per plans/leverage-audit-design.md. Requires A4.
- A7. Generalized ask skill: plain questions in any conversation route to the right composition of list/evidence/assess/rollup/audit; question catalog generalized from docs/what-regimen-helps-you-with.md and docs/regimen-categories-of-improvement.md. Requires A5 + A6.
- A8. Assess-backlog reminder: `regimen status` shows the unjudged count and a light session-start surface nudges "N conversations unassessed, start a conversation and ask". Prompting only, never auto-spending. Small; anytime after A1.

## Lane B: polish and closeout (parallel where non-conflicting)

- B1. Model backfill: populate conversations.model for Copilot/Gemini on the real-time path from the transcript (the assess path already does this); small TDD unit.
- B2. README + ARCHITECTURE refresh: fix the stale ANTHROPIC_API_KEY prerequisite (no-key adapters exist), reframe the opener from docs/what-regimen-helps-you-with.md, correct the roadmap line, document judge backends and the ask surface. Last, after Lane A lands.
- B3. Version: @regimen/cli to 1.0.0. With B2.
- B4. Issue triage: close the shipped issues (#3 #4 #6 #7 #21, #24 satisfied-by-rollup, #25 satisfied-by-A3), close-or-roadmap the long-arc (#5 #22 #26 #28 #30 #31 #32 #33 #34), file follow-up tickets (Windows no-admin daemon, update --no-daemon, TS gates + push/merge confirmation gate, gate forward-slash + spaced paths, curated judge-model list). Drafts to the engineer before any create/close.
- B5. Linux dev box: real `regimen install` to clear the dangling Codex gate leaves and stub manifest. After Lane A merges.
- B6. Archive the three sibling repos read-only (explicit engineer go).

## Progress log

- 2026-07-03: driver created. Stage 1 built and review-clean, awaiting merge gate. Facts reconciled: respond helpers already merged (lever rework through c2366c3ddd), enforcement cleanups already applied, model gap backfillable from transcripts.
