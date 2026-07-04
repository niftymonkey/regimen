# Generalized judge backends and the agent-driven no-key judging seam

> Design pass, 2026-07-03, via architect-deep. Base: main at `9e8a52a052`. Build nothing yet; this settles the shape. Companion problem statement: not everyone who might use Regimen has a separate inference mechanism beyond the tools provided at work or the one subscription they already pay for, and the judge must work for all of them. Satisfies issue #25 (the in-session judge skill) through the tier C seam.

## 0. The three tiers

- **Tier A, external key (preferred default when present):** a direct HTTP call to a model API, generalized beyond Anthropic. An OpenRouter key plus an engineer-chosen model (free models viable) works exactly like an Anthropic key does today. A curated model list is roadmap, not now.
- **Tier B, the harness CLI (existing):** the `claude --print` adapter, reusing whatever auth Claude Code already has (Bedrock, OAuth, Vertex, direct key), no separate key. Unchanged. Other harness CLIs (`codex exec`, etc.) as future adapters are roadmap, noted in decision 1.
- **Tier C, no key at all (new, every harness):** the current conversation's own agent produces the judgment. A deterministic seam: the CLI emits the exact versioned judge prompt for a conversation, the calling agent produces the verdict, and the CLI records it through the same store path with full provenance. This is the path that works on every harness with zero extra inference capacity, because the one model the engineer indisputably has is the one running the conversation.

Tiers A and B are in-process backends behind the existing `JudgeModelPort`; tier C is deliberately not a port adapter (decision 3 explains why).

## 1. Module inventory (architect-deep)

Canonical terms: module, interface, implementation, depth, seam, adapter, leverage, locality.

### Candidates and the pre-deletion test

| Candidate | Verdict | Why |
|---|---|---|
| `JudgeModelPort` (exists) | keep, unchanged | Already a real seam: two production adapters plus test stubs. The third adapter joins for free. |
| OpenAI-compatible HTTP adapter (new) | build | Without it, the chat-completions wire shape (OpenRouter, OpenAI, Groq, Ollama, LM Studio all speak it) would concentrate as branching inside the Anthropic adapter. One adapter covers the whole compatible ecosystem, which is the vendor-agnostic move; an OpenRouter-only adapter would be a shallow sibling per vendor. |
| Backend resolver (exists as `resolveDefaultJudgeModel`, misplaced in `anthropic-adapter.ts`) | keep, extract to its own module | It now composes three adapters, the env family, the precedence policy, and the no-backend guidance across two CLI callers (single assess, sweep). Living inside one adapter it names is a locality lie; extraction is a file move plus the new branch, not a redesign. |
| Verdict pipeline (new module, extracted from `judge.ts`) | build | Parse, structural validity (prose before Outcome), closed-vocabulary enforcement, anchor membership, signal and narrative assembly. Today it is private to `judgeConversation`; tier C needs the identical body. Without extraction the recorder would re-implement the exact rules the judge enforces, and the two would drift, which is precisely how a mixed corpus goes dishonest. This is the deep-module payoff of the whole design: the taxonomy redesign lands new signals in ONE place and both the in-process judge and the agent seam inherit them. |
| Agent seam (emit + record orchestration, new) | build | Without it, "no key" has no answer at all for three of the four harnesses; the complexity (transcript re-read, anchor step, version binding, intake validation, provenance) concentrates behind two CLI verbs. |
| A `JudgeBackend` super-port wrapping port selection | drop (pre-deletion: vanishes) | The resolver already returns a `JudgeModelPort`; a second port around it would be a pass-through with one caller. |
| A pending-judgment table for tier C | drop (pre-deletion: vanishes) | Record-time re-read of the transcript makes the seam stateless; the transcript-must-survive constraint already governs assess (ADR-0015). No new storage. |

### Dependency classification

- Anthropic HTTP, OpenAI-compatible HTTP: **true external** (category 4). Port at the seam (`JudgeModelPort`), mock adapters in tests. Already the pattern.
- Claude CLI: **true external** (category 4). Same port; injected runner. Already the pattern.
- The calling agent (tier C): external, but it sits OUTSIDE the process boundary and outside the request lifetime, so it is not reachable through an in-process port at all. The seam is the CLI surface itself: two commands with JSON contracts. One process emits, a different process records.
- Verdict pipeline, prompt construction, resolver: **in-process** (category 1). No ports; plain functions.

### The modules, in leverage and locality terms

**OpenAI-compatible adapter.** Interface: the existing `JudgeModelPort.complete()`; configuration is `{ apiKey, model, baseUrl, fetch? }`. Hides: the chat-completions request shape, response extraction, error mapping. Leverage: every OpenAI-compatible provider through one body; the Judge, the resolver, and the sweep never learn a vendor name. Locality: provider quirks land in one file. Test surface: injected fetch, zero network, mirroring the Anthropic adapter's tests.

**Resolver.** Interface: `resolveJudgeModel(options) -> JudgeModelPort`, options carrying the flag overrides and injectables. Hides: the env family, the precedence policy, the actionable three-tier error. Leverage: one selection policy across `assess`, `assess --all`, and any future caller. Locality: a policy change (a new tier, a precedence flip) is one file. Test surface: env and PATH-check injection, as today.

**Verdict pipeline.** Interface: pure functions over `(rawText, chunks)` returning either `{ signals, narratives }` or a typed rejection reason. Hides: JSON extraction, the validity rules, vocabulary sets, anchor resolution and membership. Leverage: two callers (in-process judge, tier C recorder) and every taxonomy change to come. Locality: the taxonomy build edits one module and both judging paths move together. Test surface: the existing judge tests exercise it through `judgeConversation`; the recorder tests exercise it through the intake.

**Agent seam.** Interface: two CLI verbs with JSON envelopes (decision 3). Hides: transcript location and re-read, the structural-event anchor step, setup resolution as of the conversation, version binding, intake validation, provenance stamping, the store write through the existing writer. Leverage: every harness gets a zero-key judge from one implementation; the bundled skill is a thin driver. Locality: the whole tier C behavior is two orchestrator functions plus the shared pipeline.

## 2. Decisions

### Decision 1: adapter shape. One port, three adapters; the new one speaks the wire protocol, not a vendor

The existing `JudgeModelPort` (system + user in, text + answering-model out) is already the right seam and does not change. The new adapter is `openai-compat` (chat-completions wire format), not `openrouter`: OpenRouter is its default base URL, but the same adapter serves OpenAI, Groq, a local Ollama, or anything else compatible, purely by configuration. The Anthropic adapter stays as the native path for direct Anthropic keys (it supports the structured-output hint and the ambient `ANTHROPIC_*` vars engineers already have). Model choice stays where it is today: resolved by the resolver from flag and env, passed into the adapter as an opaque string; the port and the Judge never see it except as response provenance. `resolveDefaultJudgeModel` moves out of `anthropic-adapter.ts` into its own `resolve` module (with a re-export kept only if a non-test import needs it; today the importers are `judge.ts` and the CLI, both ours, so a clean move is fine). Roadmap, not now: further harness CLI adapters (tier B for `codex exec` and friends) slot in as additional port adapters behind the same resolver; a curated model list for tier A.

### Decision 2: configuration. A vendor-neutral REGIMEN_JUDGE_* family layered over the existing ambient vars

New env vars (Regimen config is env-var based by convention):

- `REGIMEN_JUDGE_API_KEY`: the tier A generic key, sent as `Authorization: Bearer` to the OpenAI-compatible endpoint.
- `REGIMEN_JUDGE_BASE_URL`: default `https://openrouter.ai/api/v1`. Any OpenAI-compatible endpoint works, including a keyless local one (see the open question on keyless base URLs).
- `REGIMEN_JUDGE_MODEL`: the engineer-chosen model id. A model is required when `REGIMEN_JUDGE_API_KEY` is set (there is no sane universal default across providers), and either source satisfies it: the `--judge-model` flag alone is sufficient, `REGIMEN_JUDGE_MODEL` alone is sufficient, and the flag wins when both are present. Only when `REGIMEN_JUDGE_API_KEY` is set and neither the flag nor the env var names a model does resolution fail, with an actionable error naming a free OpenRouter example. Also honored as the model override for the Anthropic and CLI backends when set, below the `--judge-model` flag.

Existing ambient vars keep working unchanged: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` drive the Anthropic-native adapter exactly as today, so nothing regresses for current users (including the Bedrock VDI posture).

Precedence for auto-selection (no `--judge-via`):

1. `REGIMEN_JUDGE_API_KEY` set: the OpenAI-compatible HTTP backend. It outranks the ambient Anthropic key because it is the deliberate, Regimen-scoped judge configuration, while `ANTHROPIC_API_KEY` is often ambient for other tooling. Setting it is the engineer saying "judge with this".
2. Else `ANTHROPIC_API_KEY` set: the Anthropic HTTP backend (today's behavior).
3. Else `claude` on PATH: the CLI backend (today's behavior).
4. Else: fail with an actionable error that now names all three remedies, including the zero-key one: "set REGIMEN_JUDGE_API_KEY (+ REGIMEN_JUDGE_MODEL) for any OpenAI-compatible provider, set ANTHROPIC_API_KEY, install the claude CLI, or judge with the current agent via `regimen assess --emit-prompt` / `--record-verdict` (the regimen-judgment skill drives this)".

Backend forcing: `--judge-via` grows one value, `api | cli | agent` becomes the documented vocabulary, but only `api` and `cli` are resolver inputs. `--judge-via api` picks the HTTP backend the env selects (generic when `REGIMEN_JUDGE_API_KEY` is set, else Anthropic; error when neither key exists). `--judge-via cli` is unchanged. `agent` is not an in-process backend the resolver can return (the process cannot await its own calling agent), so `--judge-via agent` prints the emit/record usage on stderr and exits 2, distinct from the recorder's exit 1 (a rejected verdict, decision 3) and from exit 0 (a completed judgment); it exists so the vocabulary is complete and discoverable, not as a fourth code path, but it must never look like a successful judge invocation to a caller checking the exit code. Exit-code contract for `assess`: 0 is a recorded or emitted judgment, 1 is a recorder rejection (malformed verdict, nothing written), 2 is a usage/selector error (including `--judge-via agent` used directly, since it names a two-step flow rather than executing one). Flag precedence over env is absolute, as today.

### Decision 3: the agent-driven seam. Two deterministic CLI verbs, an envelope contract, and the shared verdict pipeline

Why not a port adapter: `JudgeModelPort.complete()` is a synchronous round trip inside one process lifetime. The tier C judge is the agent that invoked the CLI, so the round trip necessarily spans two process invocations with the agent's own turn in between. Modeling that as a blocking adapter (spawn, wait, IPC) would fake synchrony across the harness boundary and break on every harness differently. The seam is therefore the CLI surface itself, split at the natural boundary: emit the prompt, record the verdict.

**`regimen assess --emit-prompt [--session <id>]`** (harness and session resolved exactly as `assess` today). It performs the same front half as `assessConversation`: locate the transcript, read it, quarantine and insert structural events (the load-bearing anchor step, so cited anchors resolve to rows later), resolve the engineer's setup as of the conversation, and build the versioned prompt via the unchanged `buildJudgePrompt`. Then, instead of calling a port, it prints one JSON envelope on stdout and exits 0, writing no assessment run:

```json
{
  "schemaVersion": 1,
  "sessionId": "...",
  "harness": "...",
  "promptVersion": "2026-06-29",
  "rubricVersion": "2026-06-29",
  "system": "<the exact system rubric>",
  "user": "<the exact rendered conversation projection with citable ids>"
}
```

Deterministic: same transcript in, same envelope out (modulo appended conversation growth). No LLM call, no cost, no verdict storage.

**`regimen assess --record-verdict [--session <id>]`**, reading one JSON envelope from stdin:

```json
{
  "schemaVersion": 1,
  "sessionId": "...",
  "promptVersion": "2026-06-29",
  "rubricVersion": "2026-06-29",
  "judgeModel": "<self-reported, e.g. the agent's own model id>",
  "verdict": { "intent": {"value": "...", "anchors": [3]}, "assessment": {...}, "outcome": {...}, "engagement": {...} }
}
```

`verdict` is byte-for-byte the JSON object the emitted prompt elicits, so the agent produces exactly one artifact in exactly the shape it was instructed to. The recorder re-reads the transcript (rebuilding the chunk set; the reader is deterministic and the rollout is append-only, so emit-time lineSeq ids remain a valid subset even if the conversation grew between emit and record), re-inserts any new structural events (idempotent), and runs the SHARED verdict pipeline: parse, structural validity, closed-vocabulary enforcement, anchor membership against the real chunk set. On acceptance it writes through the existing `writeAssessment` (same four tables, same supersede semantics, same run identity) and prints the resulting `JudgmentDigest` JSON, exactly what `assess` prints today. Session mismatch between the flag/current session and the envelope's `sessionId` is a rejection.

Input validation is therefore not a new schema: it is the same gate every in-process verdict already passes, applied at the intake. An agent cannot record a value outside the closed vocabularies, an Outcome without preceding assessment prose, or an anchor citing a chunk id that does not exist in the conversation.

Provenance: `judgeModel` is the agent's self-reported model id, stored opaque as ADR-0008 requires; the new `judge_backend` provenance (decision 4) is stamped `agent` by the recorder itself, not taken from the envelope, so the backend dimension is trustworthy even though the model id is self-reported. Versions are stamped from the envelope after the mismatch check below, which makes them equal to the recorder's own.

**The bundled skill** (the tier C driver, satisfying #25): extend the existing `regimen-judgment` operator skill with the no-key branch. Flow: run `regimen assess --emit-prompt`; take `system` and `user` as the judging instruction and input; produce the verdict JSON object with genuine deliberation (the skill instructs the agent to actually re-read the projection it was handed, not to answer from its own conversational memory, and to write the assessment prose before choosing the Outcome, mirroring the rubric order); wrap it in the record envelope with the versions echoed from the emit envelope and its own model id; pipe to `regimen assess --record-verdict`; read back the digest and surface the headline. On a rejection (exit 1 with a reason on stderr), repair and retry up to twice, mirroring the in-process judge's retry budget; the budget lives in the skill because the agent is the model loop here. Known and accepted bias: the agent judging its own conversation is self-assessment; the `agent` backend provenance is what lets any rollup slice or discount it (decision 4). The skill honors the #25 toggle criterion at the skill layer (check enabled state before judging); the CLI verbs themselves follow assess's existing posture that the explicit invocation is the consent.

### Decision 4: failure and consistency

- **Malformed agent verdict (unparseable, invalid structure, out-of-vocabulary, zero resolvable anchors on every claim):** the recorder rejects with exit 1 and a stderr reason phrased like the in-process repair message, and writes NOTHING. No `llm-unparseable` incomplete run is stored, deliberately asymmetric with the in-process judge: there, exhausting the retry budget is the end of the line and an honest incomplete run is the truthful record; here the retry loop lives outside the process, a rejected intake will usually be retried seconds later, and a stored incomplete run would flip the session to judged and make `assess --all` skip it forever after what was just a formatting slip. Nothing recorded is the honest state for an attempt that never produced a valid verdict.
- **Grounded-but-empty (valid JSON, but no signal survives anchoring):** same rejection, with a reason naming the anchor problem, since the agent can re-cite; this differs from the in-process `insufficient-evidence` write, which exists for transcripts that give the judge nothing, a condition emit-prompt already surfaces (an empty projection) before any judging happens. Flagged as an open question below because it is a judgment call.
- **Version mismatch:** the recorder compares the envelope's `promptVersion` and `rubricVersion` to its own `PROMPT_VERSION` / `RUBRIC_VERSION` and rejects on any difference with "the judge prompt has changed; re-run --emit-prompt". This is the guard that matters with the taxonomy redesign landing in parallel: its version bumps mean a stale emitted prompt (or a `regimen update` between emit and record) can never be recorded under a rubric it was not elicited by. Versions are then stamped from the recorder's own constants.
- **Retries:** in-process paths unchanged (retry budget 2 inside `judgeConversation`, transport failure = `llm-unavailable` incomplete run). Tier C retries are the skill's, budget 2, as above.
- **Mixed-backend corpora at rollup:** one additive provenance dimension, `judge_backend`, values `api | cli | agent` (the same mechanism vocabulary as `--judge-via`), stored on `assessment_run` via one additive migration (nullable; pre-existing rows read as absent, meaning "before backends were recorded", no backfill). It is set by the code path that actually ran (resolver tags the port it built; the recorder stamps `agent`), never self-reported. Like `judgeModel` it is opaque provenance: nothing may branch on it, but the rollup and digest project it so a corpus mixing Opus-judged, free-OpenRouter-judged, and self-judged sessions is sliceable and honest. Rejected alternative: encoding the backend into the `judgeModel` string (e.g. `agent:claude-x`), which smuggles structure into a field ADR-0008 defines as opaque and invites downstream parsing. `JudgeProvenance` gains an optional `judgeBackend` field; the writer writes it; the digest projects it.

### Decision 5: blast radius

New files (all under `packages/feedback/src/judged/` unless noted):

- `openai-compat-adapter.ts`: the tier A generic adapter.
- `resolve.ts`: `resolveJudgeModel` moved from `anthropic-adapter.ts` and grown by the generic branch and the backend tag.
- `verdict.ts`: the shared verdict pipeline extracted from `judge.ts` (parse, validity, vocabularies, anchor resolution, signal and narrative assembly).
- `agent-seam.ts` (or `emit.ts` + `record.ts`): the two tier C orchestrations, composed from the same pieces `assess.ts` composes.
- Tests for each, mirroring the existing adapter and judge test shapes.

Touched:

- `judge.ts`: imports from `verdict.ts` instead of housing the pipeline; resolver import path updates. Behavior byte-identical.
- `anthropic-adapter.ts`: loses the resolver (move, not rewrite).
- `types.ts`: optional `judgeBackend` on `JudgeProvenance`.
- `writer.ts`, `digest.ts`, `store.ts`: the one additive `assessment_run.judge_backend` column (migration), written and projected.
- `assess.ts`: passes the resolved backend tag through to provenance; otherwise unchanged.
- `packages/feedback/src/cli/index.ts`: two new facades (`emitPrompt`, `recordVerdict`), resolver call site updates, error-message update.
- `packages/cli/src/cli/index.ts`: dispatch the two new assess flags; accept `--judge-via agent` as the usage printer.
- The bundled `regimen-judgment` skill: the no-key branch.
- README / skill docs: the three-tier judge configuration section.

Untouched: `prompt.ts` and `versions.ts` (the seam emits them verbatim, which is the point), `port.ts`, `claude-cli-adapter.ts`, `setup.ts` / `live-setup-source.ts`, `sweep.ts`, `slice.ts`, `sessions.ts`, `rollup.ts` (a backend dimension there is future, not this change), everything in capture, enforcement, hooks, and the daemon entrypoints.

Migration needs: exactly one additive nullable column on `assessment_run` through the shared migrations ledger. No data migration, no re-judge required; old rows simply lack a backend.

Coupling with the parallel taxonomy build (`docs/judged-taxonomy-redesign.md`): the two efforts intersect only in `judge.ts` internals and the version constants. Sequencing recommendation: land the taxonomy's core rubric first, then this design's `verdict.ts` extraction lifts the NEW pipeline, and tier C inherits the redesigned signal set with zero extra work; if this lands first, the taxonomy build edits `verdict.ts` instead of `judge.ts`, same one-place property. The version-mismatch guard (decision 4) makes the parallel landing safe at the seam regardless of order. The taxonomy's own migration (`conversation_setup_snapshot`, v7) and this design's `judge_backend` column are independent additive migrations; whichever lands second takes the next ledger number.

## 3. Open questions for the engineer (with recommendations)

1. **Precedence when both `REGIMEN_JUDGE_API_KEY` and `ANTHROPIC_API_KEY` are set.** Recommendation: the REGIMEN_JUDGE_* family wins, because it is deliberate judge configuration while the Anthropic var is ambient. The alternative (Anthropic wins, generic only via `--judge-via`) preserves the exact current behavior for anyone who sets both, but makes the generic family second-class and needs a forcing flag for the common OpenRouter case.
2. **Keyless OpenAI-compatible endpoints (local Ollama / LM Studio).** `REGIMEN_JUDGE_BASE_URL` + `REGIMEN_JUDGE_MODEL` with no key is a real zero-cost tier A. Recommendation: allow it (select the generic backend when BASE_URL or MODEL is set even without a key, sending no Authorization header); it is nearly free to support in the same adapter. Decide whether that changes step 1 of the auto-selection precedence (recommendation: yes, "any REGIMEN_JUDGE_* var set" selects the generic backend).
3. **Grounded-but-empty agent verdicts: reject, or write an honest `insufficient-evidence` incomplete run after the skill's retries are spent?** Recommendation: reject and write nothing (as designed above), keeping the session honestly unjudged and re-sweepable; revisit only if real usage shows agents legitimately unable to anchor.
4. **`judge_backend` vocabulary.** Recommendation: `api | cli | agent`, matching the `--judge-via` mechanism vocabulary (with `judgeModel` and, for `api`, the model id carrying the finer grain). Alternative considered and not recommended: provider-flavored values like `api-anthropic` / `api-openai-compat`, which read nicer in a rollup but hard-code vendor names into stored vocabulary, against the project's vendor-agnostic rule.
5. **Skill placement: extend `regimen-judgment` with the no-key branch, or ship a separate operator skill.** Recommendation: extend `regimen-judgment`; it is the same "pull a judged verdict on the current conversation" job with a different backend, and one skill keeps the engineer-facing surface single. A separate skill would only be warranted if the emit/record flow proves too long to co-live in one prompt.
6. **Should `--judge-via agent` exist at all** (as the usage printer designed here), or should the agent tier be reachable only through the two explicit flags? Recommendation: keep it; it costs a few lines and makes the third tier discoverable from the same flag every judge document already names.

## 4. Return-path summary

Tier A: `JudgeModelPort` + new `openai-compat` adapter, configured by `REGIMEN_JUDGE_API_KEY` / `REGIMEN_JUDGE_MODEL` / `REGIMEN_JUDGE_BASE_URL` (OpenRouter default), Anthropic-native path unchanged. Tier B: the existing claude CLI adapter, unchanged. Tier C: `regimen assess --emit-prompt` prints the versioned prompt envelope, the calling agent judges, `regimen assess --record-verdict` validates through the same verdict pipeline the in-process judge uses and persists through the same writer, stamped `judge_backend=agent` with the self-reported model as opaque provenance; the `regimen-judgment` skill drives the loop and owns the retry budget. One additive migration (`assessment_run.judge_backend`). Everything else additive.
