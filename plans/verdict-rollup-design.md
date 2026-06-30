# Verdict rollup read-layer (capability 1): design proposal

> Status: surface accepted on review, 2026-06-29 (see Decisions below). One TDD tracer (the deterministic header) is built and green; the rest below is designed, not built, and is not to be built past the tracer yet. Branch `feat/assess-all-bulk-judging`. Companion to ADR-0016 (the two co-equal capabilities; this is capability 1), ADR-0015 (bulk judging is a sweep), and the "Cross-conversation read direction" section of `plans/bulk-judging-design.md`.

## What this is

A cross-conversation READ over the per-conversation verdicts already in the store. The sweep (`regimen assess --all`, ADR-0015) makes the per-conversation verdict exist for the whole corpus; this layer reads across those persisted verdicts and answers "how is it going, what keeps recurring, what should I do." It is the first of the two co-equal read capabilities named in the bulk-judging design (the other, a practice-adherence check, is out of scope here). It writes nothing and adds no schema: every input row already exists from `assess`.

The read it performs is exactly the prototype's (`packages/feedback/prototypes/prose-rollup.prototype.ts`): per judged conversation it reads the assessment `narrative.prose`, the `judged_signal` values (Outcome, Intent), and the harness/model via the `conversations` join. The production version differs from the throwaway prototype in three ways that matter: it reuses the existing judged-store reads instead of hand-rolling SQL, it goes through the injected `JudgeModelPort` (so it inherits the no-separate-key Bedrock CLI judge and `--judge-via`) instead of a raw `fetch`, and it splits deterministic numbers from model interpretation as a hard architectural seam rather than a print convention.

## The load-bearing split: SQL owns every number, the model only interprets

This is the spine of the design. The synthesis model miscounts buckets, so NO number a rollup reports may come from the model. The rollup output has two parts:

- A DETERMINISTIC header computed straight from SQL: the count of judged conversations and their Outcome distribution. This is the source of truth for all numbers.
- An INTERPRETIVE synthesis: prose the model produces from the verdict assessments. The header counts are passed INTO the prompt as given facts, and the model is instructed to never recompute them. The renderer prints the header verbatim above the prose, so a reader sees the true counts regardless of what the prose says.

The tracer below embodies this split by construction: the header function has no model in it and cannot get a number anywhere but SQL.

## Module layout (feedback package)

All of it lives in `packages/feedback/src/judged/rollup.ts`, beside `assess.ts`/`digest.ts`/`slice.ts`, because it is a judged-layer read. It decomposes into a deep-ish read plus a thin orchestrator, mirroring how `assess.ts` composes reader + judge + writer:

- `rollupHeader(db, filter): RollupHeader` (BUILT, the tracer). The deterministic source of truth. Reuses `listJudgedSessions` for selection, tallies the Outcome values it returns into an ordinal worst-to-best distribution, and reports the total. Pure SQLite read.
- `collectVerdicts(db, filter): Verdict[]` (proposed). The model's input. Reuses `listJudgedSessions` to select judged sessions, then `readJudgmentDigest(db, sessionId)` per session to pull the assessment prose, the Outcome, the Intent (from the assignment signals), and the harness/model already recovered by that digest's join. No new store access is invented.
- `synthesizeRollup({ header, verdicts }, { llm, now }): RollupSynthesis` (proposed). The model interpretation. Builds the four-section prompt (the prototype's "How it's going / Recurring patterns / Two kinds of non-success / What to do"), with the header counts embedded as fixed facts, calls the injected `JudgeModelPort.complete`, and returns the prose plus provenance (`judgeModel` from the response, a pinned `rolloutPromptVersion`). Free-form prose: no structured parse, no anchors, unlike the per-conversation judge.
- `rollupVerdicts(db, { filter, llm, now }): VerdictRollup` (proposed). The orchestrator. Computes the header, collects the verdicts, calls the synthesis, and returns the combined digest. Empty corpus short-circuits to a header-only digest with `synthesis: null` and makes no model call (so a rollup over zero judged conversations is free and never errors, mirroring the sweep's "nothing to judge" path).

### Types

```
interface OutcomeTally { outcome: string; count: number }            // BUILT
interface RollupHeader { totalJudged: number; distribution: OutcomeTally[] }  // BUILT

interface Verdict { sessionId; harness; model; intent; outcome; prose }       // proposed
interface RollupSynthesis { prose: string; judgeModel: string; promptVersion: string }  // proposed

interface VerdictRollup {                                              // proposed
  schemaVersion: 1
  generatedAt: string
  header: RollupHeader            // deterministic, rendered verbatim
  synthesis: RollupSynthesis | null   // null when the corpus is empty
  filter: SessionFilter           // echoes what was rolled up
}
```

`VerdictRollup` is the read-layer's JSON contract, the rollup twin of `JudgmentDigest`. A skill or a human renderer consumes it; the renderer always prints `header` from these fields, never re-derived from `synthesis.prose`.

## Selection: reuse, and the one widening the full surface needs

The tracer reuses `listJudgedSessions(db, JudgedSessionFilter)`, whose filter is harness and model only. The full rollup wants the richer time window ("how did last week go"), which `SessionFilter` (harness, model, since, until, outcome) already expresses and `listSessions` already resolves. The production selection should therefore be the judged subset of `listSessions(filter)`, which is the exact inverse of the sweep's unjudged selection (`selectSessionsToJudge` keeps the unjudged; the rollup keeps the judged). That symmetry is the reason to prefer it over widening `listJudgedSessions` to carry since/until. Concretely, `rollupHeader` and `collectVerdicts` widen their parameter from `JudgedSessionFilter` to `SessionFilter` and select through `listSessions(...).filter(s => s.judged)`. This is a localized, reversible change; the tracer deliberately took the narrower `listJudgedSessions` seam to stay minimal.

## Command surface (cli package)

Per ADR-0012 the unified `regimen` CLI is the one argv parser and the one composition root; the feedback facade exposes typed command functions it dispatches to in-process. The rollup follows that shape exactly.

- Feedback facade: `export function rollup(options): Promise<number>` in `packages/feedback/src/cli/index.ts`, beside `assess`, `assessAll`, `evidence`, `list`. It opens the store read-only, resolves the synthesis backend with `resolveDefaultJudgeModel` (so it shares `--judge-model` and `--judge-via` with `assess`, including the Bedrock no-key CLI path), calls `rollupVerdicts`, and prints the `VerdictRollup` as JSON or as a rendered human view.
- Dispatcher: a new flat `regimen rollup` command in `packages/cli/src/cli/index.ts`, parsed with the existing `optionalFilter` helpers for the `list` filter set plus the shared judge-backend flags and `--json`. It sits with the read-and-judge primitives (`evidence` free/deterministic, `assess` paid/per-conversation, `rollup` paid/corpus), not under `assess`, because it is a READ over verdicts, not the WRITE sweep that produces them.

Inputs (flags), all reused from existing parsing: `--harness`, `--model`, `--since`, `--until`, `--outcome` (the `list` filter set), `--judge-model`, `--judge-via cli|api` (shared with assess), `--json`. Output: the rendered header plus synthesis prose, or the `VerdictRollup` JSON under `--json` for a skill to consume.

A later bundled `regimen-rollup` skill can wrap the command for in-session use, but the command is the home of the deterministic numbers: the skill must never compute the counts in prose (that reintroduces the miscount the split exists to prevent). This is why the rollup earns a code-backed command rather than being a pure compositional skill the way single-answer synthesis was made compositional in ADR-0013.

### Naming

`rollup` is the noun the bulk-judging design already uses ("a verdict rollup"). Reserving the `rollup` verb for capability 1 leaves the second co-equal capability its own verb later (for example `regimen practices`), rather than overloading one command with two corpus reads.

## Reuse summary

- `listJudgedSessions` / `listSessions` (`slice.ts` / `sessions.ts`): selection, including the judged predicate symmetry with the sweep.
- `readJudgmentDigest` (`digest.ts`): per-session prose, Outcome, Intent, harness/model, no new SQL.
- `JudgeModelPort` (`port.ts`) + `resolveDefaultJudgeModel` (`anthropic-adapter.ts`): the model seam and backend resolution, inheriting the no-separate-key CLI judge and `--judge-via`.
- The dispatcher's `optionalFilter`, `flagValue`, and judge-backend parsing (`packages/cli/src/cli/index.ts`): flag parsing.

## Tracer: what is built

`rollupHeader(db, filter?)` in `packages/feedback/src/judged/rollup.ts`, with one green test in `packages/feedback/tests/rollup.test.ts`. It selects judged conversations via `listJudgedSessions`, tallies their Outcome values into an ordinal worst-to-best distribution, and reports the total. The test seeds four judged conversations (two clean, one partial, one abandoned) plus one unjudged conversation, and asserts the total is 4, the unjudged is excluded, and the distribution is ordered worst to best with correct counts. This is the deterministic spine the synthesis composes on; it embodies the SQL-owns-numbers split because there is no model in it.

## Decisions (resolved on review, 2026-06-29)

The surface is accepted. The resolved calls:

- Selection seam: ACCEPTED. Widen `rollupHeader`/`collectVerdicts` to `SessionFilter` and select the judged subset via `listSessions(filter).filter(s => s.judged)`, symmetric with the sweep's unjudged selection. Do not teach `listJudgedSessions` since/until.
- Model-emitted counts (the prototype's "two kinds of non-success" A/B buckets): KEEP them, but ONLY as labeled model interpretation, specifically the lists of session ids the model assigns to each bucket, NEVER as authoritative counts. The deterministic header stays the single source of truth for every number; the A/B grouping renders as model-attributed session-id lists, not as a count a reader could mistake for ground truth. Making A/B SQL-backable is explicitly a parked rubric item: it needs a per-conversation "was this session actually engaged" signal (the engaged-versus-fell-short distinction noted in ADR-0016's "what this does not decide" and ADR-0008's rubric). Until that signal exists, A/B stays interpretive.
- Command vs skill home: ACCEPTED. A flat, code-backed `regimen rollup` command owns the deterministic numbers; a later `regimen-rollup` skill may wrap it but must never compute counts in prose.

Remaining open (minor, not blocking): rollup prompt versioning, whether a `rubricVersion` is warranted for free-form synthesis prose (provenance is currently `judgeModel` plus a pinned prompt version).

## Build status and lifecycle

Built: the `rollupHeader` tracer only (green). Do NOT build past the tracer pending this review. When this read-layer productionizes and absorbs the prototype, delete `packages/feedback/prototypes/prose-rollup.prototype.ts` and remove the three throwaway-prototype ignore entries with it (`.gitignore`, `eslint.config.js`, `packages/feedback/.prettierignore`); that is the throwaway's intended end and it retires the duplicated ignore list at the same time.
