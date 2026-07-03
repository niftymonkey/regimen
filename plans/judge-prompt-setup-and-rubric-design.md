# Judge prompt: setup-awareness and rubric enrichment (design proposal)

> Design pass, 2026-06-29. Proposal plus build-unit decomposition. NOT built yet (one optional tracer may exist uncommitted). The bulk sweep (`regimen assess --all`, ADR-0015) is built; this unit improves the per-conversation judge BEFORE a valuable bulk re-sweep, then the engineer re-judges with `--force`.

## Problem

`regimen assess` judges one conversation through `packages/feedback/src/judged/prompt.ts`, whose rubric is thin: a closed Intent vocabulary, a four-value Outcome ordinal with NO per-label criteria, and a prose-before-Outcome rule. The judge is setup-blind: it never sees the engineer's own established conventions, rules, or skills, so it grades every conversation against a generic baseline rather than against what was actually expected of it. A bulk run over the whole corpus therefore judges every conversation against that weak rubric. Because the judge's PROSE is the value that feeds the verdict rollup and the leverage audit (ADR-0016), the rubric must improve before a bulk assess is worth running. ADR-0016's "what this does not decide" parked exactly these enrichments and assigned them to the per-conversation judge and ADR-0008's rubric. This is where they get designed.

Three areas, all harness- and model-agnostic (the hard project constraint):

1. Setup-awareness (the headline): feed the judge the engineer's expected behaviors so the prose can assess whether the engineer's OWN conventions were honored.
2. Rubric enrichment: per-label Outcome criteria so the four values discriminate, plus a "the AI fell short" versus "the session was never engaged" distinction so a non-accomplished verdict carries real signal about CAUSE.
3. Versioning and re-sweep: bump `rubricVersion` / `promptVersion` so re-judged verdicts are distinguishable, and confirm `assess --all --force` is the re-judge path.

## Where the code is today

- `packages/feedback/src/judged/prompt.ts`: `buildJudgePrompt(chunks)` builds `{ system, user }`. The system prompt is the rubric. Outcome is named as a bare ordinal with no per-label criteria. There is no setup input.
- `packages/feedback/src/judged/judge.ts`: `judgeConversation(input, config)` calls `buildJudgePrompt(input.chunks)`, runs the port, parses, vocab-enforces, anchors, and assembles `JudgeResult`. A new signal is "a new member plus its prompt fragment and parser, never an interface change" (ADR-0008). Version defaults `DEFAULT_RUBRIC_VERSION` / `DEFAULT_PROMPT_VERSION` are `"2026-06-15"`.
- `packages/feedback/src/judged/assess.ts`: the composition root. It locates the transcript, reads it, inserts events, calls `judgeConversation`, writes the verdict. It DUPLICATES the two version constants (also `"2026-06-15"`) for its insufficient-evidence path. Two sources of truth for the same versions.
- `packages/feedback/src/judged/types.ts`: `SignalName = "intent" | "outcome"`; `ValueKind = "categorical" | "ordinal"`; the generic `JudgedSignal` row. Adding a signal is additive here.
- `packages/feedback/src/judged/writer.ts`: inserts every signal GENERICALLY by `signalName` / `valueKind` / JSON `value`. A new signal name needs no schema change.
- `packages/feedback/src/judged/digest.ts`: reads ALL signal rows generically into `signals[]` and derives the Outcome headline by `find(signalName === "outcome")`. A new signal flows into the digest's drill-down for free once it is in the `SignalName` union.
- `packages/feedback/src/judged/slice.ts`: the bulk read; projects only the `outcome` column via a hardcoded `signal_name = 'outcome'` join. Reading a new signal in bulk is a future read-unit concern, not part of adding the signal.
- `packages/feedback/src/judged/sweep.ts` + `assessAll` in `packages/feedback/src/cli/index.ts`: the sweep. `selectSessionsToJudge(db, filter, { force })` returns the unjudged subset when `force` is false and every matching conversation when `force` is true. `writeAssessment` supersedes by run identity per `(session_id, scope, assignment_id, signal_name)` (ADR-0008).

## Decision 1 (headline): setup is QUERIED at judge time through a normalized port, not BAKED at build time

Recommendation: introduce a `SetupSource` port that yields a normalized, harness-neutral `EngineerSetup`, and have the judge read it at judge time. Do NOT compile the setup into the shipped prompt or rubric.

Reasoning.

Baked (compiled into the prompt/rubric at build time) is rejected. The engineer's conventions are per-engineer, per-repository, and evolving. Compiling one engineer's CLAUDE.md or AGENTS.md into a shipped artifact would hardcode a specific engineer's setup into Regimen, would go stale the moment they edit a convention, and would violate the harness- and model-agnostic constraint (a baked rubric inevitably bakes in whichever harness's convention file the author happened to read). The shipped rubric must stay generic; the engineer-specific part is data, resolved at run time.

Queried at judge time is the contract, but with one sharpening that ADR-0016 demands and a naive "read the live filesystem now" misses: the setup the judge reasons against must be the setup AS OF THE CONVERSATION, not as of now (ADR-0016, "compose with time-scoping"). A conversation captured last week, re-judged today after CLAUDE.md changed, must be judged against last week's conventions, or the leverage audit manufactures false non-adherence. So the port's resolve takes the conversation's timestamp (`asOf`), and the contract is "the setup in force at `asOf`."

The pragmatic split between contract and first implementation:

- The CONTRACT is `SetupSource.resolve({ cwd, asOf }) -> EngineerSetup | undefined`, time-scoped by `asOf`.
- The v1 IMPLEMENTATION reads the engineer's CURRENT stated conventions (a live read) and treats them as the setup for every `asOf`. This is correct enough for the immediate re-sweep: this hub repo's conventions are stable over the corpus's recent window, and approximating last week's setup by today's setup is a bounded, documented staleness, not a fabricated value. A conversation-time SNAPSHOT implementation (read a setup snapshot captured alongside the conversation) is reserved behind the SAME port, so swapping live for snapshot is a localized change with no caller churn.

Road not taken: bake at build time (rejected above). Alternative not taken: make "live read at judge time" the contract itself (rather than "setup as of `asOf`, approximated live in v1"). Rejected because it forecloses time-scoping and would force a contract change later when snapshots arrive. Reversibility: HIGH. The judge depends only on `EngineerSetup` through the port; live versus snapshot is entirely behind the seam.

## Decision 2: setup is discovered and represented GENERICALLY, with all harness shape normalized at the adapter edge

The SetupSource adapter is the capture/adapter edge for setup, so per the project constraint it is the only place that knows harness-specific file names and locations; everything above it sees only the neutral `EngineerSetup`.

How setup is discovered (no Claude-only path):

- Stated conventions: a generic glob over a REGISTERED SET of agent-instruction file names at the conversation's repository root and at the engineer's home, not a single hardcoded path. CLAUDE.md and AGENTS.md are both just "the engineer's stated conventions"; GEMINI.md or any future harness's file joins the same registered set. The registry is the only harness-aware datum, and it lives at the edge.
- Established practices: the engineer's skill or practice directories (for example a harness skill folder, or a harness-agnostic skills location), each practice normalized to its name and its one-line summary or leading words. Again the directory locations are a registered set at the edge, normalized immediately.
- Standing rules: carried inside the same convention files; no separate source.

How setup is represented (the neutral value the prompt and judge see):

```
interface ConventionSource {
  readonly scope: "project" | "global"; // provenance, NOT a file name and NOT a harness
  readonly text: string;                // the stated conventions, verbatim, already size-bounded
}

interface EstablishedPractice {
  readonly name: string;                // e.g. "tdd", "work-router"
  readonly summary: string;             // one-line description / leading words
}

interface EngineerSetup {
  readonly conventions: ReadonlyArray<ConventionSource>;
  readonly practices: ReadonlyArray<EstablishedPractice>;
}

interface SetupSource {
  resolve(input: { readonly cwd?: string; readonly asOf: Date }): EngineerSetup | undefined;
}
```

`undefined` (no discoverable setup) is first-class: the judge falls back to its current generic behavior, exactly as a conversation with no conventions deserves. No harness or model name appears anywhere in `EngineerSetup`; `scope` carries provenance generically.

Road not taken: representing conventions as a single concatenated string (loses project-versus-global provenance, which the rollup wants) or keying them by file name (leaks the harness through the type). Reversibility: MEDIUM. `EngineerSetup` is a wire-ish shape threaded through three call sites; widening a field is easy, renaming the type touches each site.

## Decision 3: setup is injected as a delimited block in the USER prompt, with the adherence instruction in the SYSTEM rubric

`buildJudgePrompt(chunks, setup?)` gains an optional second argument. When present:

- The SYSTEM rubric gains one instruction: weigh whether the engineer's stated conventions and established practices were honored, both in the assessment prose and as a factor separating accomplished-cleanly (conventions followed unprompted) from accomplished-with-correction (conventions only met after the engineer steered).
- The USER prompt gains a clearly delimited "Expected behaviors (the engineer's own setup)" block, before the conversation, listing the conventions (by scope) and the practice roster.

When `setup` is absent or `undefined`, `buildJudgePrompt` produces today's output byte-for-byte (backward compatible default). This is the seam the optional tracer exercises.

Road not taken: putting the setup in the SYSTEM prompt (it is per-engineer data, not shipped instruction, and bloats the cache-stable system block) or inventing a third prompt role. Reversibility: HIGH (prompt text only).

## Decision 4: per-label Outcome criteria are added to the rubric

Today the rubric names the four Outcome values as a bare ordinal. Add an explicit criterion per label so the values discriminate. Draft criteria (tuned against real transcripts when built; judged from the engineer's inputs and the AI's actions only, never software quality):

- accomplished-cleanly: the assignment was accomplished and the AI followed the engineer's intent and stated conventions with little or no corrective steering.
- accomplished-with-correction: the assignment was accomplished, but only after the engineer corrected, redirected, or repaired the AI's course one or more times.
- partial: meaningful progress was made but the assignment was not accomplished; sub-goals remain open or the result does not satisfy the stated intent.
- abandoned: the assignment was dropped or left unresolved; no working result was reached and the engineer stopped without accomplishment.

Reversibility: HIGH (prompt text), but it changes verdicts, so it bumps `rubricVersion`.

## Decision 5: "the AI fell short" versus "the session was never engaged" is a NEW orthogonal judged signal

ADR-0016 notes that two of the four Outcome values (abandoned, partial) are non-accomplished and "currently indistinguishable as to cause." Model the cause as a new categorical judged signal, `engagement`, conversation-scoped, with the closed value set `engaged | not-engaged`:

- engaged: the conversation genuinely became a work session on the assignment; the work was attempted in earnest.
- not-engaged: the conversation never really became a work session on the assignment (a throwaway question, an aborted start, an unrelated detour, a setup blip); non-accomplishment here is not the AI failing at a real task.

`engagement` is orthogonal to Outcome and always defined, so the CAUSE of any non-accomplished verdict is read by COMPOSING the two: `not-engaged + abandoned` means the session was never a real attempt, while `engaged + abandoned|partial` means the AI fell short on real work. The orthogonal framing also gives the rollup a denominator: it can exclude `not-engaged` conversations before tallying "the AI fell short," so a corpus full of quick throwaway questions does not drag down the apparent performance.

This is a pure ADR-0008 generic-row addition: a new `SignalName` member, a new prompt fragment, a new parser branch, and a new vocabulary set. No schema change (writer is generic), and it flows into the digest's drill-down for free (digest reads all signals). It does NOT enter `slice.ts`'s bulk projection or the in-session digest headline in this unit; surfacing it in bulk is a future read-unit concern.

Road not taken:

- Fold cause into the Outcome ordinal (split "abandoned" into two values). Rejected: cause is not a rank, so it breaks the load-bearing ordinal that trending and comparison read as a spectrum, and ADR-0008 fixed the four-value ordinal explicitly.
- Carry cause only in the prose. Rejected: prose is not sliceable, and ADR-0016 wants the cause to "carry real signal," meaning queryable for the rollup and audit.
- A conditional `shortfall` signal present only on non-accomplished outcomes (`ai-fell-short | never-engaged`, absent otherwise). Viable and abstention-clean, but it couples two signals (the judge must keep presence consistent with Outcome). The orthogonal `engagement` is more robust and a cleaner denominator. Reversibility between the two models: HIGH (both are a SignalName member plus a prompt fragment plus a parser).

## Decision 6: versioning is centralized, then both versions bump; `--force` is the confirmed re-sweep path

Centralize the duplicated `DEFAULT_RUBRIC_VERSION` / `DEFAULT_PROMPT_VERSION` (today copied in both `judge.ts` and `assess.ts`) into one module both import, so a bump is single-sourced. Then:

- The rubric change (per-label criteria in Decision 4, the `engagement` signal in Decision 5) bumps `rubricVersion`.
- The prompt-template change (setup injection in Decisions 1 to 3) bumps `promptVersion`.

Both change in this effort, so both bump (suggested value: the build date, consistent with the existing date-stamped scheme).

Re-sweep path confirmed against the sweep code: `regimen assess --all --force` runs `selectSessionsToJudge(db, filter, { force: true })`, which returns EVERY matching conversation (not just unjudged), and each is re-judged through the same `assessConversation`; `writeAssessment` supersedes the prior run by run identity per `(session_id, scope, assignment_id, signal_name)`. The bumped `rubric_version` / `prompt_version` on `assessment_run` make the re-judged verdicts distinguishable from the old ones. So `--force` IS the re-judge path, and the version bump is what makes it detectable rather than a silent overwrite.

## Build-unit decomposition (ordered; future TDD vertical slices, NOT built here)

Each unit is a red-green-refactor slice verified with SCOPED checks (`bunx eslint src tests`, `bun run typecheck`, `bun test --timeout 30000 ./tests/<unit>.test.ts`).

### Unit 1: centralize the judge version constants (foundation refactor)

- Delivers: one module exporting `RUBRIC_VERSION` and `PROMPT_VERSION`; `judge.ts` and `assess.ts` import them instead of holding private copies. No behavior change (values unchanged).
- Verified: a characterization test pins the exported values; existing `judge.test.ts` and `assess.test.ts` stay green; the constant appears in exactly one source file.

### Unit 2: per-label Outcome criteria in the rubric

- Delivers: the SYSTEM prompt carries an explicit criterion for each of the four Outcome labels (Decision 4); `RUBRIC_VERSION` bumped.
- Verified: a `prompt.test.ts` asserts each label's criterion text is present in `buildJudgePrompt({...}).system`; existing judge tests green; the bumped version is asserted.

### Unit 3: the `engagement` signal (fell-short versus never-engaged)

- Delivers: `engagement` added to `SignalName` and to a closed vocabulary set; a prompt fragment eliciting it with anchors; a `buildSignals` branch that parses, vocab-enforces, and anchors it; persisted through the existing generic writer row; surfaced in the full digest's `signals[]`. `RUBRIC_VERSION` bumped (shared with Unit 2 if the same sweep).
- Verified: judge tests assert `engagement` parses from a well-formed verdict, abstains (absent) on an out-of-vocab or unanchored value, and is written and read back through writer and digest; no schema migration.

### Unit 4: the prompt builder accepts and injects setup (the seam; the optional tracer covers this)

- Delivers: `EngineerSetup` / `SetupSource` types (Decision 2); `buildJudgePrompt(chunks, setup?)` injects the delimited expected-behaviors block plus the system adherence instruction (Decision 3); absent setup reproduces today's output. `PROMPT_VERSION` bumped.
- Verified: a `prompt.test.ts` asserts a convention's text and a practice's name appear in the built prompt when setup is supplied, and that the output is unchanged when it is omitted (backward-compat).

### Unit 5: the live SetupSource adapter (the harness-neutral edge)

- Delivers: an adapter that, given a `cwd` and `asOf`, globs the REGISTERED convention file set (CLAUDE.md, AGENTS.md, and the registered roster) at repo root and home and reads the practice directories, normalizing to `EngineerSetup`; harness shape lives only here; `asOf` accepted and (v1) reads the live setup with a documented staleness caveat.
- Verified: tested against a temporary fixture directory holding multiple convention files and a fake practice dir; asserts neutral normalization (no file name or harness leaks into `EngineerSetup`); `undefined` when nothing is discoverable.

### Unit 6: thread setup through assess and wire the adapter in the CLI

- Delivers: `assessConversation` resolves setup through an injected `SetupSource` (tests inject a stub) and passes it to `judgeConversation` and on to `buildJudgePrompt`, with `asOf` set to the conversation's time; the CLI composition root binds the live adapter for both single `assess` and the `assess --all` sweep.
- Verified: an integration test with a stub source asserts the resolved setup reaches the built prompt; the sweep path (`assess --all --force`) re-judges with the enriched prompt; existing `cli-assess` and `cli-assess-all` tests green.

### Unit 7 (wrap): confirm the re-sweep and finalize versions

- Delivers: both `RUBRIC_VERSION` and `PROMPT_VERSION` at their bumped values; a test asserting `assess --all --force` selects already-judged conversations and supersedes them; a short note in the bulk-judging plan pointing the engineer at the `--force` re-sweep after this lands.
- Verified: the force-selection test passes; the version values are asserted in one place.

## Out-of-scope findings (sink, not acted on)

- The two version constants are duplicated across `judge.ts` and `assess.ts` today (one source of truth violated). Folded into Unit 1 above rather than left loose, because the bump needs it; flagged here as the pre-existing smell.
- `slice.ts` projects only the `outcome` signal column. Reading `engagement` (or any new signal) in the BULK read is a future read-unit concern (the verdict rollup / leverage audit in ADR-0016), not part of adding the signal. Noted, not acted on.
- The in-session `JudgmentDigest` headline leads with Outcome and the assessment; whether `engagement` should join the headline or stay a drill-down is a read-surface decision for the in-session skill (#25), out of scope here.
- A friction or effort axis distinct from accomplishment (ADR-0016's third parked enrichment) is NOT designed here; only the two areas this unit was scoped to (per-label criteria, engagement) are. Listed for completeness.
</content>
</invoke>
