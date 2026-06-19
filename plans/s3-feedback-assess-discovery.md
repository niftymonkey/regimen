# S3 `feedback assess`: discovery spec

> Status: discovery complete (2026-06-15). Input to the S3 TDD build. Mirrors `plans/s2-content-reader-discovery.md` in structure and rigor.
> S3 builds the judgment-layer spine ADR-0008 specified: one judgment pass over one conversation that writes typed, evidence-anchored judged signals (Intent and Outcome) plus a prose assessment, then reads them back as a `JudgmentDigest`. It is issue #21. The output contract is ADR-0008; the content it reasons over comes from the built S2 reader (`regimen-feedback/src/loader/rollout/codex-reader.ts`); the LLM seam follows the PRD ("the judge is the engineer's already-configured agent LLM, behind a swappable seam").
> Design questions are answered from the ADRs and PRD, which lead the codebase. The one current, built exception is the S2 content-reader contract, which S3 consumes unchanged.
> Module boundaries below were designed with the `architect-deep` deep-module lens (three parallel interface designs for the Judge seam, synthesized). Open decisions for the user are in section 9; resolve the load-bearing ones before the build.

## TL;DR

- **`feedback assess` is one deep orchestration over one conversation.** It resolves the session, locates the rollout transcript, runs the S2 reader once, inserts the reader's structural events into the store so `{eventHash}` anchors resolve, hands the content chunks to the Judge, and writes the Judge's verdict to the four ADR-0008 tables superseding any prior run. Each step is already-built or thin glue except the Judge.
- **The Judge is the one deep new module, behind a one-call interface.** `judgeConversation({ sessionId, chunks }, config?)` returns a pure `JudgeResult` the orchestrator maps onto the rows. Prompt construction, the LLM round-trip, output parsing, vocabulary enforcement, anchor validation, bounded retry, fail-closed assembly, and provenance stamping all hide behind that interface.
- **The LLM is the single injected seam (category-4, true external).** A narrow `JudgeModelPort` (system + user text in, text out) with a production adapter (the engineer's configured agent LLM) and a deterministic test stub. The whole judgment pass is testable in-process with no network because parsing and anchor validation live above the port, inside the Judge.
- **Anchor insertion is the load-bearing mechanism.** S2's anchor-resolution note is binding: `{eventHash}` anchors resolve only against rollout-derived events, hooks never capture assistant text, and the tailer is off by default, so `feedback assess` MUST insert the reader's structural events itself, idempotently via the `event_hash` PK, before the digest read can resolve anchors. The reader already mints these events with the same `seq` and `base()` the content projection anchors against, so insertion is a direct write of `rolloutRead().events`.
- **Fail-closed is three distinct cases.** Missing transcript exits with a clear error and writes nothing. Insufficient evidence writes the run as `complete=false` with the signal absent, never a fabricated value. Malformed or unresolvable LLM output retries within a bounded budget, then yields an incomplete run, never a half-judged verdict.
- **Two cheap forward seams, no over-build.** A `Segmenter` injection point (holding today's single whole-conversation slice) and the open `value_kind` / `signal_name` shape ADR-0008 already designed. The seven reserved signals and the real segmenter are NOT built here; ADR-0008 explicitly rejected specifying them now.

## 0. What S3 is and is not

In: one `feedback assess --session <id>` / `--harness codex` CLI pass that produces the ADR-0008 judged output for one conversation, the Judge module behind it, the anchor-insertion step, the `JudgmentDigest` read, and re-judge supersede semantics.

Out (reserved by ADR-0008, built where they are used): the assignment segmenter (#22), the seven reserved signals beyond Intent and Outcome (#22), the in-session judge skill that reads the digest (#25), the long-arc rollups (#22 to #24), cross-conversation reads, and any window/aggregate narrative.

Harness scope: the CLI ships `--harness codex` (the trial harness) and the generic `--session <id>` form, exactly as `feedback evidence` does. The Judge, the digest, and the four tables are harness-agnostic; only session-resolution and transcript-location are Codex-specific, and both reuse built Codex modules.

## 1. Orchestration and data flow, end to end

The orchestrator (`assessConversation`, the `feedback assess` command body) runs one pass. Every step except the Judge call is built or thin glue.

1. **Resolve the session id.** `--session <id>` is taken verbatim (harness-agnostic, the form Claude Code uses). `--harness codex` resolves the current session from the filesystem via the built `resolveCurrentSession({ dataDir, codexHome, cwd })` (`src/codex/resolve-session.ts`), exactly as `feedback evidence` does. A null resolution is a clean "could not resolve the current Codex session" error (section 5).

2. **Locate the rollout transcript for that session id.** This is net-new: nothing today maps a session id to its rollout file path (the resolver goes file name to id; the tailer reads every file). The Codex rollout file name embeds the session id as its trailing UUID (`rollout-<ISO8601>-<uuid>.jsonl`, the regex in `resolve-session.ts`), so a reverse scan of `CODEX_HOME/sessions` (recursive `readdirSync`, match the UUID, take the path) finds it without opening a file. A missing file is the fail-closed missing-transcript error (section 5). This locator is Codex-specific and small; it lives beside the session resolver.

3. **Read the transcript once with the S2 reader.** `rolloutRead(content, { complete })` returns `{ events, content, unknownRecordTypes, quarantined }` (`src/loader/rollout/codex-reader.ts`). `complete` is true for assess: assess judges a conversation as it stands, and an explicit assess invocation treats the transcript as the unit to judge, so the `session.end` boundary is appropriate. (If the user wants an open conversation never to gain a `session.end` from assess, that is a small open question, section 9.5. The reader already supports both.) The reader's fail-closed diagnostics (`unknownRecordTypes`, `quarantined`) are surfaced, not swallowed: quarantined load-bearing records route to the store's `quarantine` table (the existing `store.quarantine(rawLine, reason)` path), and a non-empty `unknownRecordTypes` is reported on stderr so vendor drift stays visible (ADR-0007). A transcript that yields zero content chunks is the insufficient-evidence path, not an error (section 5).

4. **Insert the structural events into the store (the load-bearing anchor step).** Write every event in `rolloutRead().events` through the existing `store.insertEvent(event)` (`src/store.ts`), which is `INSERT OR IGNORE` on the `event_hash` PK and runs the deterministic projections in the same transaction. This is what makes `{eventHash}` anchors resolvable: the content chunks' `{eventHash}` anchors are the lowercase-hex of these exact events' hashes (the reader computes both from the same `base()` and `seq`), so once the events are rows, every anchor in the verdict resolves. Idempotency is structural: re-running assess re-inserts the same hashes as no-ops; if the daemon's tailer already drained this rollout, those rows already exist and the inserts collapse. Section 4 details the mechanism and the hook-vs-rollout timestamp divergence this navigates.

5. **Assemble the Judge input.** The content chunks (already extracted, filtered, truncated, anchored, in `lineSeq` order) plus the session id. No re-reading, no re-projection: the chunks are the Judge's whole view of the conversation. The orchestrator also derives the known-anchor set from the chunks (the validation set the Judge checks returned anchors against).

6. **Invoke the Judge.** `await judgeConversation({ sessionId, chunks }, config?)`. The Judge does the LLM round-trip, parsing, vocabulary enforcement, anchor validation, retry, and fail-closed assembly, and returns a `JudgeResult` (section 2). The orchestrator passes no LLM in production (the default agent-LLM adapter resolves behind the seam); tests inject a stub.

7. **Write the verdict, superseding any prior run.** In one transaction against the judged tables (a new migration, section 1a): mint a `run_id`, insert one `assessment_run` (stamping `rubric_version`, `prompt_version`, `judge_model`, `complete`, `created_at`), upsert one whole-conversation `assignment`, insert the `judged_signal` rows (Intent and Outcome when present), and insert one `assessment` `narrative`. Supersede is by latest-run-wins on `(session_id, scope, assignment_id, signal_name)` for signals and the equivalent for the narrative (section 7).

8. **Expose the `JudgmentDigest` read.** The CLI prints the digest as JSON, the judged twin of `feedback evidence`. The in-session skill (#25) is a later consumer of the same read; S3 builds the read and the CLI surface, not the skill.

The orchestrator is a shallow conductor by design: its complexity is the sequencing and the fail-closed branching, and every heavy piece (reader, store, judge) is a deep module it composes. The deletion test confirms the shape: delete the orchestrator and the sequencing concentrates into the CLI; delete the Judge and the judgment logic concentrates across every caller. So the Judge earns depth; the orchestrator earns only its place as the composition root.

### 1a. The judged store: a new migration on the shared ledger

ADR-0008 names four tables; none exists yet (the store stops at migration v5, the evidence layer). S3 adds them as one migration (v6) on the existing `schema_migrations` ledger (`src/store.ts`), per ADR-0006's single-ledger rule and ADR-0008's "no per-row schema_version."

- `assessment_run (run_id TEXT PK, session_id TEXT NOT NULL, rubric_version TEXT NOT NULL, prompt_version TEXT NOT NULL, judge_model TEXT NOT NULL, complete INTEGER NOT NULL, created_at TEXT NOT NULL)`. Index `(session_id, created_at)` so the latest run per session is a cheap lookup.
- `assignment (session_id TEXT NOT NULL, assignment_id TEXT NOT NULL, PRIMARY KEY (session_id, assignment_id))`. The reserved nullable `assignment_id` reference for #22's segmenter; S3 writes exactly one whole-conversation row per session.
- `judged_signal (session_id TEXT NOT NULL, scope TEXT NOT NULL, assignment_id TEXT, signal_name TEXT NOT NULL, value_kind TEXT NOT NULL, value TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY (session_id, scope, assignment_id, signal_name))`. `value` is JSON text typed by `value_kind`. The PK is the supersede key: latest run wins by `INSERT OR REPLACE` keyed on it (section 7). `assignment_id` is nullable per ADR-0008 (a `scope=conversation` signal carries the whole-conversation assignment id today; nullability is the reservation, not a live null).
- `narrative (session_id TEXT NOT NULL, scope TEXT NOT NULL, assignment_id TEXT, narrative_type TEXT NOT NULL, prose TEXT NOT NULL, anchors TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY (session_id, scope, assignment_id, narrative_type))`. `anchors` is the JSON-encoded `AnchorRef[]`. No typed value; no part in any rollup.

The migration is additive and ships with the existing migration-test discipline (`store.test.ts` asserts each migration applies and reopening is a no-op). The judged tables join the same WAL store the loader writes, so the daemon writing events and `feedback assess` writing a verdict coexist (assess writes the judged tables and, transiently, events the daemon may also write, both idempotent).

### 1b. Module map and dependency classes

- **`assessConversation` (orchestrator).** In-process composition root. Dependencies: the locator (filesystem, owned, local-substitutable via a temp dir in tests), the S2 reader (category-1 in-process, owned), the store (category-2 local-substitutable, `:memory:` in tests), and the Judge (which owns the one external seam). No port at the orchestrator's own edge; it is tested by running it against a temp store and a temp sessions dir with a stub Judge model.
- **`locateRolloutFile` (Codex transcript locator).** In-process filesystem scan, Codex-specific, beside `resolve-session.ts`. Local-substitutable (temp dir).
- **The Judge (`judgeConversation` + `JudgeModelPort`).** The one deep new module; the LLM is its single category-4 seam (section 2).
- **The judged-store writer and the `JudgmentDigest` reader.** Category-2 (SQLite), owned, mirroring `store.ts` (writer) and `evidence.ts` (reader). The reader is pure SQLite, no Judge, no network, like `readEvidenceDigest`.

## 2. Judge prompt and IO design

The Judge is a deep module: a narrow interface over a body that hides prompting, the LLM call, parsing, vocabulary enforcement, anchor validation, retry, and fail-closed assembly. Three interface designs were explored (minimal, flexible, common-case optimized) and synthesized into the shape below: the common-case ergonomics (a trivial default call) with the minimal design's strict invariants and clean row-projection, taking from the flexible design only the two forward seams ADR-0008 already reserves.

### 2a. Interface

```ts
// The whole surface. One pass, one conversation, one return value.
export function judgeConversation(
  input: JudgeInput,
  config?: JudgeConfig, // entirely optional; omit for the default path
): Promise<JudgeResult>;

export interface JudgeInput {
  sessionId: string;
  chunks: ContentChunk[]; // the S2 reader's content projection, in lineSeq order
}

export interface JudgeConfig {
  llm?: JudgeModelPort;     // omit -> the resolved default agent-LLM adapter (the PRD seam)
  rubricVersion?: string;   // omit -> the built-in current rubric version
  promptVersion?: string;   // omit -> the built-in current prompt version
  retryBudget?: number;     // omit -> bounded default (e.g. 2)
  segmenter?: Segmenter;    // omit -> the whole-conversation segmenter (forward seam, 2e)
  now?: () => Date;         // omit -> () => new Date(); injectable for deterministic created_at
}
```

The common caller writes `await judgeConversation({ sessionId, chunks })`: no LLM, no versions, no budget, the PRD's "zero caller wiring for the default" honored literally.

### 2b. The injected LLM port (the one category-4 seam)

```ts
export interface JudgeModelPort {
  complete(request: JudgeModelRequest): Promise<JudgeModelResponse>;
}
export interface JudgeModelRequest {
  system: string; // the rubric/instruction prompt the Judge built (version-pinned)
  user: string;   // the rendered content projection
  responseSchema?: unknown; // optional structured-output hint; the production adapter may pass it on
}
export interface JudgeModelResponse {
  text: string;   // raw model output; the Judge parses and validates it
  model: string;  // which model answered; flows up into provenance.judgeModel
}
```

The port is deliberately narrow and provider-neutral: system + user text in, text out, plus an opaque model id. It carries no thinking, no effort, no tools, no streaming, no token usage. Those are production-adapter concerns; if they crossed the port they would leak the harness's model into the judgment logic and break the harness- and model-neutral spine. Parsing, vocabulary enforcement, and anchor validation live above the port, inside the Judge, so the only thing that varies across the seam is "how do you turn a prompt into a string," which is exactly what production-vs-test differ on.

### 2c. Return shape (maps 1:1 onto the ADR-0008 rows; the Judge writes no SQLite)

```ts
export interface JudgeResult {
  complete: boolean;                 // -> assessment_run.complete
  provenance: JudgeProvenance;       // -> assessment_run.{judge_model, rubric_version, prompt_version}
  signals: JudgedSignal[];           // 0..n; an absent signal is an abstention, never fabricated
  narratives: JudgedNarrative[];     // the scope=conversation assessment today
  incompleteReason?: IncompleteReason;
}
export interface JudgeProvenance {
  judgeModel: string;                // opaque; nothing downstream may branch on it (ADR-0008)
  rubricVersion: string;
  promptVersion: string;
}
export interface JudgedSignal {
  scope: "conversation" | "assignment";
  assignmentId: string;              // the whole-conversation assignment today
  signalName: SignalName;            // closed controlled vocab: "intent" | "outcome" today
  valueKind: ValueKind;              // open tag: "categorical" | "ordinal" today
  value: IntentValue | OutcomeValue; // JSON-encoded by the orchestrator, typed by valueKind
  anchors: AnchorRef[];              // >= 1, every one validated against the chunk anchor set
}
export interface JudgedNarrative {
  scope: "conversation" | "assignment";
  assignmentId: string;
  narrativeType: string;             // open discriminator; "assessment" today
  prose: string;                     // reasoning, generated before the Outcome label
  anchors: AnchorRef[];              // >= 1, validated
}
type IntentValue =
  | "refactor" | "bug-fix" | "feature" | "test-writing"
  | "exploration" | "schema-change" | "other";
type OutcomeValue = // ordinal, low -> high; the rank order is load-bearing
  | "abandoned" | "partial" | "accomplished-with-correction" | "accomplished-cleanly";
type IncompleteReason =
  | "insufficient-evidence"  // no chunk gave the judge enough to ground a signal
  | "llm-unparseable"        // bounded retry exhausted on malformed/invalid output
  | "llm-unavailable";       // the port itself failed (network/transport)
```

`AnchorRef` and `ContentChunk` are imported from the S2 reader unchanged; the Judge introduces no new id space. The orchestrator maps `JudgeResult` onto the rows mechanically: `provenance` plus `complete` to `assessment_run`; each `JudgedSignal` to a `judged_signal` row with `value` JSON-encoded; each `JudgedNarrative` to a `narrative` row with `anchors` JSON-encoded.

### 2d. How the judge elicits each output, grounded in `feedback-surfacing.md`

The prompt is version-pinned (the `promptVersion` provenance stamp names which one ran). It must elicit, harness- and model-neutrally:

- **Intent** (categorical, closed vocab): one value naming what the engineer was trying to do, from `refactor | bug-fix | feature | test-writing | exploration | schema-change | other`. The explicit `other` is the escape so a wrong fit is never forced (ADR-0008). The judge reads the engineer's prompts (the `human_prompt` chunks) primarily, the AI's actions secondarily; Intent names the engineer's purpose, not what code changed (DOMAIN-LANGUAGE).
- **Outcome** (ordinal, 4-value): one value from `abandoned < partial < accomplished-with-correction < accomplished-cleanly`, scored on whether the AI accomplished the assignment and how much steering it took (the two-part question in `feedback-surfacing.md`), explicitly NOT on transcript length and NOT on software quality (ADR-0003, ADR-0008). The rank order is load-bearing for trending.
- **The assessment prose** (the `scope=conversation` narrative): a readable synthesis of how the conversation went. Generated BEFORE the Outcome label (ADR-0008: "the assessment prose is generated before the Outcome value, so reasoning precedes the label"). The prompt orders prose-then-Outcome; the parser enforces that an Outcome present with no assessment is an invalid result the Judge will not construct.
- **Anchors per signal and narrative** (`AnchorRef[]`, at least one each): the judge cites the specific chunks justifying each claim. The prompt presents each chunk with its anchor as a citable token and instructs the judge to cite only from that set. The judge reads engineer inputs and AI actions only (the chunk kinds the reader already filtered to), never model-private reasoning (the reader already excluded reasoning by type), never grades software quality.

### 2e. Reliable, resolvable anchors: structured output, validation, retry

The single hardest IO problem is that anchors the LLM returns must resolve to real events. The posture:

1. **Constrain the output shape.** The Judge requests structured output: a JSON object with `intent`, `outcome` (each `{ value, anchors }`), and `assessment` (`{ prose, anchors }`), where every `anchors` entry is one of the citable tokens the prompt enumerated. The production adapter passes a JSON schema via `responseSchema` when the model supports it (the recommended structured-output path); the Judge does not depend on the model honoring it, because step 3 validates regardless. Citable-token form: the prompt gives each chunk a short stable id (its `lineSeq`, or an index), and the judge cites those ids; the Judge resolves an id back to the chunk's real `AnchorRef`. This means the LLM never has to emit a raw `eventHash` or a `toolCallId` correctly; it cites an enumerated id, and the Judge maps id to anchor. (This sidesteps the model fabricating or mistyping a 64-char hex hash, the obvious failure of asking the model to echo anchors verbatim.)
2. **Parse into the typed shape.** Extract Intent, Outcome, prose, and the per-claim cited ids. An Intent value outside the closed vocab, an Outcome outside the four ranked values, a missing prose-before-Outcome, or a missing anchor citation is a parse failure, not a coerced value. Out-of-vocab is never silently mapped to `other`.
3. **Validate anchors against the known set.** Each cited id maps to a chunk; the chunk's `AnchorRef` is checked for membership in the set derived from `input.chunks`. A citation that does not resolve is dropped; a claim left with zero resolvable anchors is demoted to an abstention (the signal is absent).
4. **Bounded retry on malformed output.** On a parse failure or an all-anchors-unresolvable claim, re-prompt once (up to `retryBudget`, default 2) including the parse error so the model can repair. On exhaustion, the affected signal abstains (absent) and the run is `complete=false` with `incompleteReason="llm-unparseable"`. A transport failure from the port (after the adapter's own retries, if any) yields `complete=false`, `incompleteReason="llm-unavailable"`. The Judge resolves to a `JudgeResult` in every degraded case; it throws only on a caller-contract violation (e.g. empty chunks where a conversation was promised), which is a programming bug, not a run outcome.

Validating anchors against the in-memory chunk set (not against SQLite) is deliberate: the chunks carry their `AnchorRef`s, the orchestrator already inserted the matching events, and in-process validation keeps the Judge free of a SQLite port and keeps the default path a one-liner. The chunk-id indirection plus membership validation is the whole reliability story; see section 9.1 for the one residual question (whether the model should ever cite by raw anchor).

### 2f. The two forward seams (cheap, no over-build)

ADR-0008 explicitly rejected specifying the reserved signals' shapes or building the segmenter now. S3 takes only the two seams the ADR already reserved, each holding today's exact scope:

- **`Segmenter`** (`segment(content): AssignmentSlice[]`), injected via `config.segmenter`, defaulting to a whole-conversation segmenter that returns one slice. The Judge is written against `AssignmentSlice[]` and never special-cases "one assignment," so #22's real segmenter is an injection swap with no Judge change, matching the nullable-`assignment_id` reservation. `AssignmentSlice` carries only `{ assignmentId, scope, chunks }` today; the segmenter's own output fields (boundary anchors, ordering index) are NOT modeled now, per the ADR.
- **The open `signal_name` / `value_kind` shape.** `SignalName` is a union (`"intent" | "outcome"`) that grows by adding a member; `ValueKind` is an open string tag with `"categorical" | "ordinal"` live. A new signal (#22) is a new vocab member plus its prompt fragment and parser, flowing through the same generic row, NOT an interface change. There is no pre-built registry of the seven reserved signals and no rich per-signal-kind schema; that is the rejected over-build. The forward constraint holds by construction: the Judge has no access to evidence counts, so a future correction-rate signal cannot copy its deterministic denominator into the judged row (ADR-0008's read-time-resolution rule).

## 3. Config seam: which LLM judges, and how provenance is stamped

The PRD is the authority: "the judge LLM defaults to the engineer's already-configured agent LLM in the first implementation. The configuration sits behind a seam that allows swapping in a different LLM later without changing callers." S3 honors this literally.

- **The seam is `config.llm?: JudgeModelPort`.** When omitted (the common path), `judgeConversation` resolves the default by calling an internal `resolveDefaultJudgeModel()` that constructs the production adapter over the engineer's already-configured agent LLM. Zero caller wiring; the swap to a neutral judge model later is a change to what `resolveDefaultJudgeModel()` returns, not a change to any caller or to `JudgeInput`/`JudgeConfig`.
- **The production adapter wraps the configured agent LLM.** For the Codex trial the configured agent LLM is reachable via the Anthropic-compatible API the engineer already runs work against; the adapter maps `complete()` to one model call (system + user, optional JSON-schema structured output via `responseSchema`, a streaming-safe `max_tokens`), and returns the answering model id as `response.model`. All model id, token cap, structured-output, and retry concerns stay inside the adapter, never on the port. How the adapter discovers the configured model (env vars the harness already sets, a Regimen config file, or a `--judge-model` override) is open question 9.2; the default-resolution seam holds whichever wins.
- **Provenance stamping.** `judge_model` comes from `response.model` (the model that actually answered, not a hard-coded string), so a swap is self-describing. `rubric_version` and `prompt_version` are the version strings the Judge ran (defaulted from built-in constants, overridable via `config`). All three are stamped on every `assessment_run`, including an incomplete one, so a re-judge after a rubric or prompt change is detectable rather than a silent overwrite (ADR-0008).
- **The no-branch constraint.** `judge_model` is opaque provenance only. No read-time query, no rubric, and no type tag may branch on its contents (ADR-0008: "the moment code switches on it the judged layer acquires a model-specific behavior"). The `JudgmentDigest` reader selects and projects `judge_model`; it never filters or forks on it.

## 4. Anchor insertion mechanism (load-bearing)

This is the piece S2's discovery spec flagged as binding for S3. The chain of facts (confirmed against the built code):

- The hook path stamps `timestamp = captured_at`; the rollout path stamps `timestamp = the record's own timestamp`. The `event_hash` covers the timestamp (`src/hash.ts` over `canonicalJson`), so the two capture paths produce different hashes for the same logical moment.
- The content chunks' `{eventHash}` anchors are the lowercase-hex of the rollout-derived events' hashes: `rolloutContent` computes each anchor as `hashHex(codexUserPrompt(base, seq))` / `hashHex(codexAgentMessage(base, seq))` / `hashHex(codexToolPre(base, span))`, using the same `base()` (sessionId, timestamp, model, cwd) and the same per-session `seq` that `rolloutEvents` uses to mint the structural events. So a content anchor resolves only against the event that `rolloutEvents` produced from the same line.
- Hooks never capture assistant text, and the rollout tailer is off by default. So at assess time there is no guarantee any of the rollout-derived structural events are in the store. Therefore **`feedback assess` must insert `rolloutRead().events` itself, and anchor to those**.

The mechanism:

- **Insert all of `rolloutRead().events`.** The orchestrator writes every event via `store.insertEvent` (the same writer the daemon uses), inside the store's existing per-event transaction (event row + projections). The `{eventHash}` chunk anchors now resolve to rows: `user_prompt` (carrying `seq`), `agent.message` (carrying `seq`), the web-search `tool.pre`/`tool.post` self-paired spans, and the tool spans. The `{sessionId, toolCallId}` chunk anchors resolve via the `tool_call_spans` PK that `openToolSpan` populated.
- **Idempotency.** `insertEvent` is `INSERT OR IGNORE` on the `event_hash` PK. Re-running assess re-inserts identical hashes as no-ops; the projections run only when a row is newly inserted (the writer guards `projectSignals` on `info.changes === 1`), so a re-insert never double-projects. If the daemon's tailer drained this rollout already, those rows exist and the inserts collapse harmlessly. The hook-vs-rollout timestamp divergence does NOT cause a collision here: assess inserts only rollout-derived events, which is the same hash space the tailer would produce, so the two converge rather than conflict. The divergence the `seq` index solves is the real within-transcript one (same-millisecond rollout records), already handled by the reader's `seq` attribute; assess does not reintroduce it.
- **Resolution path per anchor variant.** `{sessionId, toolCallId}`: resolve via `tool_call_spans` PK `(session_id, tool_call_id)`, valid regardless of capture path (the rollout `call_id` equals the tool span id). `{eventHash}`: resolve via the `events` PK against rollout-derived rows; valid only because assess just inserted them. The digest reader (section 6) treats an anchor whose row is somehow absent as a non-resolving anchor it surfaces honestly, never a fabricated event, but in the normal flow every verdict anchor resolves because assess inserted its event in the same pass before writing the verdict.
- **Ordering within the pass.** Insert events (step 4) BEFORE writing the verdict (step 7), and judge between. The verdict's anchors are validated by the Judge against the in-memory chunk set (section 2e); the store insert is what makes them resolvable at read time. Both must precede the digest being readable.

## 5. Fail-closed behavior

Three distinct cases, each with a defined outcome (ADR-0008, ADR-0007, `feedback-surfacing.md` "Honest over tidy"):

1. **Missing transcript.** The locator finds no rollout file for the session id (or the file cannot be read). Exit with a clear, specific error to stderr (which session, which expected location) and a nonzero exit code. Write NOTHING: no `assessment_run`, no events, no half-judged result. ADR-0008: "a missing transcript exits with a clear error and never a half-judged result." This is the only case that errors out; the others record an honest incomplete.
2. **Insufficient evidence.** The transcript reads but the conversation gives the judge nothing to ground a signal on (zero content chunks, or chunks that yield no defensible Intent/Outcome). The run is written with `complete=false`; the unsupportable signal is ABSENT from `judged_signal`, never a fabricated value or a default. Absence is first-class (ADR-0008): a missing signal is the abstention. The assessment narrative may still be written if the judge can say something honest about the thin conversation; if not, it too is absent and the run records `incompleteReason="insufficient-evidence"`. The events are still inserted (the structural record is valid even when the judgment abstains).
3. **Malformed or unresolvable judge output.** The LLM returns output the Judge cannot parse into the closed vocabularies, or cites anchors that do not resolve. The Judge retries within the bounded budget (section 2e), then: any signal that did validate is written; any that did not is absent; the run is `complete=false` with `incompleteReason="llm-unparseable"` (or `"llm-unavailable"` if the port itself failed). Never a half-judged verdict passed off as complete, never a coerced label. The orchestrator writes the incomplete run honestly so a reader sees "judged, but the run did not finish clean," not silence.

In all three, the `JudgmentDigest` read (section 6) is the honest surface: missing transcript means the digest's unjudged branch (no run), incomplete means a judged branch carrying `complete=false`, and a present-but-absent signal renders as absent, never as a default zero.

## 6. CLI surface

`feedback assess`, mirroring `feedback evidence` exactly (`src/cli/index.ts`):

- `feedback assess --session <id>`: the generic, harness-agnostic form. Judges the conversation with that session id.
- `feedback assess --harness codex`: resolves the current Codex session from the filesystem (built `resolveCurrentSession`), then judges it. Same precedence and same "could not resolve" handling as `feedback evidence`.
- Usage error (`feedback assess` with neither flag): `usage: feedback assess --session <id> | --harness codex`, nonzero exit, mirroring the evidence command.

What it prints: on success, the `JudgmentDigest` as JSON on stdout (the judged twin of the evidence digest the in-session skill will read). The reader (`readJudgmentDigest`) is the `JudgmentDigest` constructor, a pure SQLite read like `readEvidenceDigest`:

- A session with no run (never assessed, or store/file absent) prints the UNJUDGED branch: a discriminated union on a `judged` boolean, `judged: false`, mirroring `EvidenceDigest`'s unknown branch, produced by its own constructor (ADR-0008: "a genuinely different shape, never the judged shape with empty placeholders"). It covers Feedback off, no run yet, or the transcript gone.
- A session with a run prints the JUDGED branch, `judged: true`, leading with the conversation assessment (the `scope=conversation` narrative and its anchors), with the lone Outcome sitting directly beneath it (the single whole-conversation assignment's Outcome), then the assignment and its signals as the drill-down. This is ADR-0008's headline-led read. The reader sorts deterministically (so a re-judge of the same input is stable); the tie-break is the reader's call.
- An incomplete run still renders as the judged branch carrying `complete=false`, so the surface is honest about a run that did not finish clean.

Stderr carries the operational noise that is not the digest: the ADR-0007 `unknownRecordTypes` drift report and any quarantine count, so the JSON on stdout stays the clean digest the skill parses.

The assess command does NOT require the daemon (it reads the transcript and writes the store directly, like a one-shot), but it does require the store to exist and be migratable. It opens the store read-write (it writes the verdict and inserts events), unlike the evidence command's read-only open.

## 7. Re-judging: supersede through run identity

ADR-0008: re-running the judge must not duplicate signals (an acceptance criterion of #21). The mechanism:

- Every run has an identity: `assessment_run.run_id` (a fresh id per pass), stamping `rubric_version`, `prompt_version`, `judge_model`, `complete`, `created_at`.
- Every `judged_signal` and `narrative` row carries its `run_id`. The latest run wins, superseding per `(session_id, scope, assignment_id, signal_name)` for signals and `(session_id, scope, assignment_id, narrative_type)` for narratives. The PKs above ARE these supersede keys, so the write is `INSERT OR REPLACE` keyed on the PK: a second assess of the same conversation replaces the prior run's rows in place, carrying the new `run_id`. No duplicate signals, by construction.
- The `assessment_run` rows accumulate (each pass is its own run row), so the provenance history is visible: a re-judge after a rubric bump leaves both run rows, and the stamped `rubric_version` makes the change detectable rather than a silent overwrite (ADR-0008). The digest reader resolves "the verdict" as the rows whose `run_id` is the latest run for the session (the `(session_id, created_at)` index), which is what `INSERT OR REPLACE` already leaves in the signal/narrative tables.
- A re-judge that yields fewer signals than a prior run (e.g. an Outcome that now abstains) must not leave a stale prior-run Outcome row. The write deletes the session's prior judged rows that the new run did not re-emit, then inserts the new run's rows, all in one transaction. (Equivalently: replace by PK for re-emitted signals, and delete-by-session-not-in-new-run for dropped ones. The transaction makes the swap atomic so a reader never sees a mix of two runs.)

## 8. TDD build plan and fixtures

The build follows red-green-refactor with the `tdd` skill, producer-before-consumer where the data flows, and a fully injectable judge so every test is deterministic with no network. `bun test` is the runner; tests build small inline transcripts plus reuse the captured `samples/` fixtures, exactly as the S2 content tests do. Stub the function under test first so red is caused by the implementation, not a missing import.

Build order (producer before consumer):

1. **The judged-store migration (v6) and the writer.** Red: a test asserts the four tables exist after open and that a second open is a no-op (mirroring `store.test.ts`). Then the supersede writer: insert a run + signals + narrative, re-insert a second run, assert the latest run's rows win and no duplicates remain (the section-7 contract). This is the producer of the wire format; verify it before the reader.
2. **The `JudgmentDigest` reader (`readJudgmentDigest`).** Red against a store seeded by the writer. Assert: unjudged branch for a session with no run (its own constructor, mirroring `unknownDigest`); judged branch leads with the assessment and the lone Outcome beneath it; incomplete run renders `complete=false`; deterministic sort. Anchors round-trip (the JSON `anchors` decode back to `AnchorRef[]`). This is the contract #25 reads, so it is pinned before the orchestrator wires it.
3. **The Judge, against a stub `JudgeModelPort`.** Stub the port (text in, canned text out), then test the Judge's depth in-process: happy path (well-formed output parses to Intent + Outcome + assessment, anchors validate, provenance stamped from `response.model`); reasoning-before-Outcome enforced; out-of-vocab Intent rejected (not coerced to `other`); Outcome outside the four values rejected; a cited anchor not in the chunk set dropped, and a zero-anchor claim demoted to absent; malformed output drives the bounded retry then `complete=false`; a thrown port yields `incompleteReason="llm-unavailable"`. The stub also asserts the prompt the Judge builds excludes nothing it should include and includes the citable-id enumeration (a focused assertion on the `JudgeModelRequest` the stub captures). No network anywhere.
4. **The transcript locator (`locateRolloutFile`).** Red against a temp sessions dir: a session id maps to its rollout file by the UUID in the name; a missing id returns null (the missing-transcript signal). Reuse the `resolve-session.ts` regex fixture pattern.
5. **The orchestrator (`assessConversation`), end to end with a stub judge model and a `:memory:` store.** This is the acceptance test, the external interface the PRD names as the test surface. Assert: it inserts the reader's events (so a `{eventHash}` anchor in the verdict resolves at read time); it writes exactly one run, one assignment, the signals, one narrative; a re-run supersedes (no duplicates); missing transcript errors and writes nothing; insufficient evidence (empty transcript) writes `complete=false` with the signal absent; the printed digest matches the reader's contract. The judge model is the stub, so the whole orchestration is deterministic.
6. **The CLI command (`feedback assess`).** Mirror `cli.test.ts`: `--session` and `--harness codex` dispatch, the usage error, stdout carries the digest JSON, stderr carries drift/quarantine. Reuse the CLI test harness that runs `runCli(argv)` against a temp data dir.
7. **The production LLM adapter.** Built last and tested thinnest: a unit test that it maps `JudgeModelRequest` to the expected model-call shape and reads `response.model` back, with the SDK call itself mocked at the library boundary (the one acceptable `as`-at-the-boundary spot). No live network in the suite. A live smoke against the real configured LLM is a manual build-time check, not a committed test.

Fixtures: reuse the S2 captured fixtures under `samples/` (do NOT read or modify them in this spec; the build references them). The Judge and orchestrator tests need only (a) inline transcripts the S2 content tests already demonstrate building (`tests/codex-content.test.ts` patterns) to produce known chunks, and (b) a stub `JudgeModelPort` returning canned verdicts keyed to those chunks' citable ids. No new real-transcript capture is needed for S3. If a build step surfaces a need for a real captured verdict (e.g. to tune the prompt against a real model), capture it as a build-time step and record it, do not pre-author it here.

## 9. Open questions for the user

Each carries a recommendation. The load-bearing forks (9.1, 9.2) should be resolved before the build; the rest carry a default the build can proceed on.

STATUS 2026-06-15: all resolved. 9.1 and 9.2 are settled inline below. 9.3 to 9.6 are accepted on their recommended defaults (retryBudget = 2 and date-stamped version strings; the reader's 2000/2000 truncation default; honor open state via the tailer's newest-is-open rule; assess runs regardless of the enabled flag). The user delegated the lighter forks to the defaults.

1. **Anchor citation form (most load-bearing for the Judge IO). RESOLVED 2026-06-15: option (a), enumerated chunk ids.** Should the judge cite anchors by an enumerated per-chunk id the Judge maps back to the real `AnchorRef` (the section-2e design), or should it emit raw `AnchorRef`s (an `eventHash` hex string or a `toolCallId`) the Judge validates directly? Options: (a) **enumerated chunk ids** (the model cites `chunk 7`, the Judge maps to the anchor), or (b) **raw anchors** (the model echoes the hex/id). Recommend **(a)**: a model asked to echo a 64-char sha256 hex will mistype or hallucinate it, breaking resolution; citing an enumerated id the Judge controls makes anchor resolution near-deterministic and keeps the validation a pure membership check. (b) is simpler to prompt but fragile exactly where reliability matters. This shapes the prompt, the parser, and the retry posture, so settle it first.
2. **How the production adapter discovers the configured agent LLM. RESOLVED 2026-06-15: Anthropic, reading `ANTHROPIC_API_KEY` (plus model and base URL) from env per option (a), with the `--judge-model` override of option (c). The judge is the engineer's Claude, independent of the Codex harness under trial. The key must also be exported on the trial Mac (folds into SETUP / 1.12), and lives in env only, never hardcoded.** The PRD says "the engineer's already-configured agent LLM," but does not name the discovery mechanism for the Codex trial. Options: (a) **read the env/config the harness already sets** (an Anthropic-compatible base URL + key + model the engineer's setup exports), zero new config; (b) **a Regimen config file** naming the judge model explicitly; (c) **a `--judge-model` CLI override** layered on top of (a) or (b). Recommend **(a) as the default, with (c) as the override**: it honors "the same LLM the engineer is already running their work with" with zero setup, and the override is the escape hatch for a deliberate neutral-judge run. This is load-bearing because the adapter and the `resolveDefaultJudgeModel` seam depend on it; the rest of the design is independent of which wins, but the adapter cannot be finished without it.
3. **Retry budget and prompt/rubric version values.** What is the bounded `retryBudget` default (the section-2e repair loop), and what initial `rubricVersion` / `promptVersion` strings does v1 stamp? Recommend **retryBudget = 2** (one initial call plus two repairs is enough to recover a model that merely fumbled the JSON shape, without burning cost on a model that cannot comply) and **date-stamped version strings** (e.g. `rubric=2026-06-15`, `prompt=2026-06-15`) so a bump is human-legible in the run history. Low-stakes; the build can proceed on these defaults and tune.
4. **Truncation budget at the assess step.** The S2 reader truncates tool output head+tail at a 2000/2000 default and marks the elision; S2's open question 6 left the exact judge-facing budget to the assess step. Should assess accept the reader's default, or pass a tuned budget? Recommend **accept the reader's default for v1** and revisit only if the judge prompt overflows the model's context on a real large-output conversation; tuning is a one-line change to the reader's constants or a config the reader could accept later. Note: the reader's truncation is currently a module constant, not a parameter, so passing a tuned budget is itself a small reader change, out of S3's scope unless needed.
5. **`complete` flag on the reader for assess.** Section 1 passes `complete: true` to `rolloutRead` so an explicit assess treats the transcript as the unit to judge and gains a `session.end`. But `feedback-surfacing.md`'s "Honest over tidy" says an open conversation renders as open, never force-closed. Options: (a) **`complete: true`** (assess stamps a `session.end` at the last timestamp, treating the assessed transcript as the unit), or (b) **`complete: false` for the live/newest session** (no `session.end`, the conversation stays open), matching the tailer's open-vs-finished rule. Recommend **(b)**: assess should not force-close an open conversation just because it was judged mid-flight; mirror the tailer's rule (newest/live session is open, older is complete) by checking whether the resolved session is the newest rollout. This is a small branch in step 3 and avoids assess lying about lifecycle state. Flagging because it is a genuine honest-state fork, not a default to wave through.
6. **Does assess require Feedback to be enabled?** `feedback evidence` reads the store regardless of the enabled flag. `feedback assess` writes the store (events + verdict). Should it respect the enabled flag (the capture-and-storage privacy gate), refusing to write when Feedback is off, or run regardless because it is an explicit, user-invoked judgment of a transcript the user is pointing at? Recommend **run regardless of the flag**: assess is an explicit invocation against a specific transcript the user named, not background capture, so the privacy gate (which governs ambient capture) does not apply; the user invoking assess IS the consent. But surface this, because it writes structural events into the store as a side effect, which a strict reading of "Feedback off means nothing captured" could object to. If the stricter reading wins, assess refuses when the flag is absent.
