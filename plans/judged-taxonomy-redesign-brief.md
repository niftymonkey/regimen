# Seed brief: redesign Regimen's judged-signal taxonomy

Handoff for a dedicated architect-deep design effort. Read this first, then the linked artifacts.

## 0. Purpose (the lead; do not bury it)

The point of this effort is to make `regimen assess`, the per-conversation LLM-as-judge, emit the judged signals that actually serve the categories of improvement Regimen exists for. This drives what the judge is BUILT to produce, and it decides what the two cross-conversation reads (the verdict rollup and the leverage audit) and the in-conversation checkpoints can deliver. This is not an abstract taxonomy exercise. The deliverable must drive building the right thing in the assess layer. If a decision does not change what the judge emits or what a consumer can read, it does not belong here.

## 1. Where this came from (lineage; do not lose it)

- The branch `feat/judge-prompt-setup-rubric` did one job: make the per-conversation judge prompt worth running a full-corpus re-judge against. It enriched the prompt in eight committed-but-not-merged, reviewed, all-green commits: per-label Outcome criteria, a new `engagement` signal (engaged / not-engaged), injection of the engineer's own setup into the prompt, a live `SetupSource` adapter (globs CLAUDE.md / AGENTS.md / GEMINI.md and the skill dirs), and the threading of setup through `assess` and the CLI, time-scoped to the conversation. Design record: `plans/judge-prompt-setup-and-rubric-design.md`. Version stamps sit at 2026-06-29. The re-sweep (`assess --all --force`) was never run; it spends model budget and was left pending. This branch work is PAUSED, awaiting this effort.
- The pivot: the enrichment took the four-value Outcome ordinal as fixed without anyone validating those are the right things to measure. A taxonomy-review agent proposed splitting Outcome into two orthogonal axes (accomplishment and correction-cost); the real corpus then showed a deeper attribution gap; and the realization landed that all of this was still solution-first.
- The fork (the conversation that produced this brief): stop and answer the prerequisite problem-space question first, what categories of improvement Regimen is actually for, before any more taxonomy work. That is now DONE and settled (section 2).
- Then, testing the current and proposed taxonomy against the settled categories (a coverage sub-agent) produced a three-signal REDO (add `attribution`, `verification`, `adherence` on top of the accomplishment + correction-cost split).
- Then, stress-testing that redo with three completeness lenses (producer, consumer, hard-cases) showed the redo DOES NOT survive (section 3). This effort is the redesign that follows.

## 2. The driver: the settled categories of improvement

Read `docs/regimen-categories-of-improvement.md` (rigorous) and `docs/what-regimen-helps-you-with.md` (user-facing). These are the ground truth the taxonomy must serve. In brief:

- Four categories of improvement, each with an actor, an action it drives, and a horizon:
  1. Framing (set up): how the goal, scope, and context are stated. Tight loop.
  2. Conducting (run): how the work is decomposed, delegated, given autonomy, interrupted, reset. Tight loop.
  3. Verification (receive): whether the engineer checked what came back before accepting. Tight loop; chronic over-trust or under-trust reads as a trend.
  4. Leverage (durable kit): acquire / fix / retire, over two axes (liveness, cost) at two scopes (single lever, whole kit). Long arc.
- Attribution is a DIAGNOSTIC, not a category: when work went worse than it should have, was the cause the framing, the AI itself, or the environment. It routes to the category that can act, scopes the options actually available, protects the engineer from misplaced blame, and carries a cost-aware "was it worth doing this way" note.
- A gate: was there a real task (a non-task cannot fall short).
- Two lenses over everything: time-range, and harness plus model.
- The boundary: Regimen surfaces (up to naming a fix and offering to help build it), never takes the move, never renders a verdict on the person.

## 3. The redo that failed, and the forks to resolve

The proposed redo is in `scratchpad/taxonomy-redo-under-test.md` (kept: accomplishment + correction-cost split, engagement with the "setup blip" wording fix; added: attribution on-shortfall, verification always-on, adherence per-practice). The three completeness lenses (producer / consumer / hard-cases) found it does not survive. Resolve these forks, in roughly this order.

### Fork A (linchpin): the shortfall-gating flaw
The redo gives Framing and Conducting a home only via `attribution`, which fires only on a shortfall. That re-creates, for every quiet case, the exact masking the redo fixed for Verification by making it always-on. The driver-central QUIET cases fall through: a session that succeeded but was poorly conducted (drives a real action, has no home); an idle or missing lever with no shortfall; well-run-but-not-worth-it (self-contradictory, since attribution needs a shortfall this case lacks); and, critically, the POSITIVE "what actually worked / what carried this success" read, which the driver makes first-class precisely because it drives no immediate action but is still valuable. Decide: do the quiet-case reads (Conducting quality, lever liveness, the positive what-helped) get their own reads that fire independent of a shortfall, or is `attribution` un-gated? The positive read must be representable and queryable, not merely an inferred aggregate trend.

### Fork B: attribution's shape
It is a single coarse 5-way categorical. It cannot represent a multi-cause shortfall (forces misplaced blame or a masked fix), cannot cluster three `framing` shortfalls into "the same missing lever" (the discriminating specific pattern lives only in the prose, which the rollup spine bars as an authoritative number source), and OMITS a leverage value, so a live kit conflict has nowhere to land. Decide: multi-value (a primary plus contributing causes), a finer or structured recurring-pattern representation, and a leverage or kit value.

### Fork C: adherence (the most broken piece)
Multiple independent problems. (1) Storage: per-practice rows collide on the store primary key `(session_id, scope, assignment_id, signal_name)` with insert-or-replace, so the "additive, no schema migration" claim is false; the only migration-free shape is one structured value, which needs a new value-kind and puts per-practice counts behind JSON extraction, defeating the "SQL owns every number" spine both consumers depend on. (2) Temporal provenance: `live-setup-source.ts` reads today's filesystem for every asOf, so a bulk sweep faults conversations that predate a lever, the exact thing the driver and the leverage-audit design forbid; there is no practice-version or as-of field stored. (3) Actor conflation: the roster is largely engineer-owned levers (skills the engineer invokes), so "honored" for those is about whether the ENGINEER used the lever, not whether the AI complied, different actor, different anchor. (4) Roster blindness: a good practice not expressed as a rostered file is invisible, and its silence is indistinguishable from compliance. (5) Practice-kind asymmetry: skills have a per-conversation firing count (`skill_invocations`), so "never fired" is computable, but rules and conventions have no firing signal, so the liveness and deletion tests cannot run uniformly. Decide: adherence's scope (AI-compliance-only, or split engineer-use from AI-compliance), its storage shape (admit a keyed schema, or a structured value, and own the migration), its provenance mechanism (a conversation-time setup snapshot, or a first-seen gate), and whether adherence is even the right vehicle for the leverage-audit input.

### Fork D: cost and kit-coherence cannot be parked
The driver names two live actions that depend on a cost read: retire or loosen a lever that works but costs more than it saves, and do-not-delegate-this-class (well-run-but-not-worth-it). The redo parks cost onto the friction axis, but that makes those driver-named reads undeliverable. Decide: de-park a minimal cost or effort signal now, or explicitly and honestly scope those two reads as deferred and say what unlocks them.

### Fork E: verification's definition
Refine the signal so it is emittable and portable: a check must be VISIBLE in the transcript (a silent reader who accepts is transcript-identical to a blind accepter, so absence of a visible check must not be read as "no check occurred"); add a "nothing to verify" value for sessions with no AI change; normalize "check" and "accept" across harnesses (chat-style harnesses have no accept event, and harness-automatic hook or test runs are not the engineer's own verifying act, which is what Verification scopes); collapse unchecked-versus-unclear or add a positive-evidence-of-skip anchor rule (you cannot cite a chunk for a non-event, and anchorless signals are dropped); and note that the current value set covers only over-trust, not the under-trust (wasteful over-checking) half the driver names.

### Fork F: migration and read-layer reality
Own the plumbing the redo waved away. Even the kept outcome split breaks the already-built `rollupHeader` and `listJudgedSessions`, which key on `signal_name='outcome'` and a hardcoded 4-value order; removing or replacing `outcome` returns unscored for the whole corpus. New signals only become trustworthy numbers with deterministic GROUP-BY reads; without them they land in the non-authoritative prose layer. And anchors are mandatory in `buildSignals` (a signal with zero anchors is silently dropped), so every "absence" value (ai-model, environment, verification-unchecked, adherence-not-applicable) needs either an anchor-optional path or a redesign to only-anchorable states. The design must state its store and read-layer changes explicitly.

## 4. Constraints (hard)

- Judge remit: the engineer's inputs and the AI's actions only, never software quality (ADR-0003).
- Harness- and model-agnostic: every signal and value holds for any agent CLI and any model; harness specifics live only at the capture edge.
- The signal store is generic (name, value-kind, value), but be honest where the redesign needs to extend it (a new value-kind, a keyed schema); do not repeat the redo's false "no migration" claim.
- Regimen surfaces, never acts, never renders a verdict on the person (a grounded specific pattern, never a trait judgment).
- Two co-equal consumers: the verdict rollup and the leverage audit (ADR-0016).
- Real-time, intra-conversation intent: signals must be readable while a conversation is open, not only post-mortem.

## 5. Reconcile with the paused branch and the re-sweep

Say explicitly what of the eight-commit enrichment survives, changes, or is superseded by the redesign, and what that means for the re-sweep that was the branch's original goal. In particular: the `engagement` signal and the setup-injection plumbing already exist; the live `SetupSource` adapter is implicated by Fork C (asOf, roster blindness, actor conflation); the four-value Outcome criteria are being replaced by the two-axis split plus new signals. The re-sweep (`assess --all --force`) should grade against the REDESIGNED taxonomy, so it is deferred until this lands. State the sequence: what to build, in what order, and when the re-sweep runs.

## 6. Deliverable

Produce, as files, design only, no code changes and no branch changes:

- A design document (suggest `docs/judged-taxonomy-redesign.md`): the redesigned signal set (each signal, its values, its emission rule including always-on-versus-on-shortfall, its anchor rule, its storage shape, and which driver element it serves), the read-layer and store changes it requires, and a coverage statement mapping every driver element (the four categories, attribution, the gate, both lenses) to its home.
- An ADR draft (next number in `docs/adr/`), superseding or amending ADR-0008 (the four-value ordinal and the generic signal model) as needed, recording the redesign and its trade-offs.
- Every fork in section 3 resolved with reasoning, or, where it is genuinely a human call, flagged as an OPEN QUESTION with the options and a recommendation, for morning review.
- The section-5 reconciliation with the paused branch and the re-sweep sequence.

For the hardest forks (A, C), sketch two or three candidate shapes and pick one with reasoning, rather than settling on the first idea. Before finalizing, self-critique the design against the driver and against the section-3 findings: does every category, including the quiet cases and the positive read, have a home; does anything still force a verdict on the person; does the store actually hold it.

## 7. How to run (AFK)

Solo deep-design run, unattended. Be rigorous: deep-module thinking, real alternatives, decisions justified against the driver and the findings. Resolve the forks; do not block on them; flag genuine human-call items as open questions with a recommendation. Read this brief, the two driver docs, the redo spec, `plans/judge-prompt-setup-and-rubric-design.md` (the paused branch design), the consumer designs (`plans/verdict-rollup-design.md`, `plans/leverage-audit-design.md`), and the relevant code (`packages/feedback/src/judged/` types, prompt, judge, assess, slice, digest, rollup, live-setup-source; and the store) and ADRs 0003, 0008, 0016. Verify claims about the code against the code. Write the deliverable as files. Change no code and no branch state. Nothing here is adopted; this is a draft for human review.
