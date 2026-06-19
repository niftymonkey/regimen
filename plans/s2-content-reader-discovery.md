# S2 Codex content-reader: discovery spec

> Status: discovery complete (2026-06-14), critic-corrected. Input to the S2 TDD build.
> Produced by a read-only workflow (5 lens-finders + synthesis + adversarial completeness critic) over the 9 real `~/.codex/sessions` transcripts. The critic rated the synthesis "sound-with-corrections"; its 5 corrections are folded in here and flagged inline as [critic].
> S2 builds the *content* projection ADR-0007 deferred: the judge reads conversation text (anchored to events, never stored), as an extension of the one per-harness reader `regimen-feedback/src/loader/rollout/codex-reader.ts`. Open decisions for the user are in the last section; resolve them before the build.

## TL;DR

- **Read content from one stream: `response_item`.** It is the only ordered, interleaved log, the only stream with a role discriminator and typed content parts, and the stream the existing reader already walks. `event_msg` (user_message / agent_message / *_end twins) is a partial-coverage duplicate and is never read for content.
- **Exclude model-private reasoning by record type, unconditionally:** `response_item/reasoning` and `event_msg/agent_reasoning`. The oldest build exposes reasoning in plaintext, so "drop only encrypted reasoning" would leak chain-of-thought the surfacing rule forbids.
- **Recognize by shape, not by `cli_version`.** Two builds both report `0.128.0` yet emit different record populations. Dispatch on `(type, payload.type, key signature)`.
- **The existing reader silently skips unknown records, which ADR-0007 forbids.** S2 replaces that with count-and-surface (benign unknowns) plus quarantine-and-surface (malformed load-bearing records), for both the structural and content paths.
- **The one hard gap: assistant answers have no anchor target today** (no call_id, no turn_id, no id, and timestamps collide with reasoning). This needs a producer-side decision (see open questions).
- **Genuine engineer prose is rare and well-delimited:** only 7 of 73 `response_item` user records across the whole corpus are real engineer input; the other 66 are machine-injected (IDE wrapper, guardian replays, AGENTS.md, environment_context) and partition cleanly by 4 leading markers.

## 1. Authoritative stream and the dedup rule

**Canonical stream = `response_item`, for every text class.** `event_msg` is used only as a cross-check, never read for content. Reasons:

1. It is the only ordered, interleaved IO log. One pass yields `developer / user / user / reasoning / assistant:commentary / exec_command / assistant:final_answer / user` in true order. `event_msg` has no `developer` role, no interleaving, no tool-result ordering. ADR-0008 re-render stability and a future #22 segmenter both need a single total order; only `response_item` has one.
2. It is the stream the existing reader already dispatches on for tool spans (`codex-reader.ts` lines 134-206), so adding content keeps the fold single-pass.
3. Its `message` records carry `content[]` structure (typed `input_text` / `output_text` parts) and the `role` discriminator the projection needs.

One finder argued for `event_msg/user_message` as a cleaner human-input source ("uncontaminated by injections"). Rejected: `event_msg` is not cleaner, it is just partial. In vscode sessions the IDE wrapper rides inside `event_msg/user_message` too; the separate-record injections (AGENTS.md, environment_context, guardian replay) simply land as their own `response_item` user-role records. The contamination axis is the session **originator**, not the stream. So canonicalize on `response_item` and filter there.

**Dedup rule (structural, by record type, applied in the existing single fold):**

1. **Assistant visible text:** only `response_item/message role=assistant`, joining `content[]` parts where `type=="output_text"`. Never also read `event_msg/agent_message` (byte-identical twin) nor `event_msg/task_complete.last_agent_message` (third copy). [critic] This single-source rule is a global invariant verified across all 9 files: `response_item` assistant count == `event_msg` `agent_message` count, joined `output_text` byte-identical in every file (OLDEST 2/2, MID 11/11, 106/106, 28/28, RECENT 4/4, 7/7, ...).
2. **Human prompt text:** only `response_item/message role=user`, after the injection filter (section 6). Never also read `event_msg/user_message` (duplicates the genuine subset).
3. **Tool result text:** only `response_item/function_call_output` and `custom_tool_call_output` (`.output`). Never also read `event_msg/exec_command_end.aggregated_output` or `patch_apply_end`. The `*_output` path is the only era-portable result source; the `event_msg` ends are era-thin and reading both double-counts one `call_id`'s result.
4. **Web search:** query from `response_item/web_search_call.action`. Never also read `event_msg/web_search_end`. The existing reader already self-pairs `web_search_call` by `webSearchSeq`; content reuses that.

No content-hash comparison is needed: the canonical-stream rule already picks exactly one record per logical turn, so dedup is deterministic and re-render stable.

## 2. Include / exclude policy

Grounded in `docs/feedback-surfacing.md` (the judge reads the engineer's inputs and the AI's actions, never the model's private reasoning, never grades software quality) and ADR-0008.

| Source | Ruling | Rationale |
| --- | --- | --- |
| `response_item/message role=user` (post-filter) | **include** | The engineer's input. Filter injected non-human content first. |
| `response_item/message role=assistant` (`output_text`) | **include** | The AI's visible action/answer. Carry `phase` (commentary/final_answer) as metadata. |
| `response_item/function_call.arguments`, `custom_tool_call.input` | **include** | The AI's tool action. [critic] Extract per tool, not wholesale (see section 3). |
| `response_item/function_call_output` + `custom_tool_call_output.output` | **include-truncated** | The AI action's result. Era-portable. Head+tail truncation budget; unwrap by try-parse. |
| `response_item/web_search_call.action.query` (+ `queries[]`) | **include** | An action parameter, not prose, not reasoning. `open_page` variant has no query. |
| `response_item/message role=user` injected blocks | **exclude** | Machine-injected context (IDE wrapper, `<environment_context>`, AGENTS.md, guardian replay). Filter by leading marker; for vscode, extract the genuine ask after `## My request for Codex:`. |
| `response_item/message role=developer` | **exclude** | Synthetic harness/system text (permissions, collaboration_mode, skills_instructions, enforcement notices). |
| `response_item/reasoning` | **exclude** | Model-private reasoning. Exclude by record type unconditionally; OLDEST exposes it in plaintext. |
| `event_msg/agent_reasoning` | **exclude** | Same private chain-of-thought, plaintext, OLDEST-only. The exclude set must name this type too. |
| `event_msg/agent_message`, `user_message`, `task_complete.last_agent_message` | **exclude** | Duplicate twins of canonical `response_item` records (dedup). |
| `event_msg/thread_name_updated` | **exclude** | [critic] Model-authored conversation-title metadata. Not a dedup twin (nothing else carries it); excluded as non-conversation metadata. |
| `event_msg/exec_command_end`, `patch_apply_end`, `web_search_end` | **exclude** | Richer but era-thin twins of `response_item/*_output`; double-count one `call_id`. (Caveat: `patch_apply_end.changes` is the only parsed per-file unified-diff source, MID-only, so it cannot be the content spine.) |
| `event_msg/error.message` | **exclude** | Platform/API fault (nested JSON HTTP 400), not the engineer or AI talking. Candidate fault-anchor for a deterministic signal. MID-only. |
| `event_msg/token_count`, `task_started`, `task_complete` | **exclude** | Non-text metrics and turn boundaries. (task_* are #22 segmenter anchor candidates, no text.) |
| `user_message.images` / `local_images` / `text_elements`; `input_image` parts | **exclude (for now)** | Empty arrays across all 9 files. Fail-closed/skip until a real non-empty instance is captured. |
| `session_meta.base_instructions` / `turn_context.user_instructions` | **ambiguous** | base_instructions is system prompt (exclude). user_instructions is the engineer's persistent prefs (AGENTS/CLAUDE.md-equivalent): not a conversation turn, but maybe projectable as scoped context. **User decision.** |
| `event_msg/guardian_assessment` | **ambiguous** | Third-party safety verdict (risk_level/rationale/decision_source/user_authorization), structurally close to private reasoning. Lean exclude-from-text, candidate for a deterministic Enforcement-fired evidence signal. **User decision.** MID-only. |
| top-level `compacted.replacement_history` | **ambiguous** | Post-compaction snapshot of full message records. Ingesting re-introduces already-projected turns; but it is the only record of rotated-out content. Recommend skip-and-count. **User decision.** Single instance in corpus. |

## 3. Field map

| Source | Path | Shape / variance |
| --- | --- | --- |
| Human prompt | `response_item` where `payload.type=='message' && role=='user'`; text = `content[]` filtered to `input_text`, join `.text`; then injection-filter | `content[] = [{type:'input_text', text}]`. Injected blocks recognized by joined-text leading marker. |
| Assistant answer | `response_item` `message role=='assistant'`; text = `content[]` filtered to `output_text` | `content[] = [{type:'output_text', text}]`. `phase` in {commentary, final_answer} MID/RECENT, absent OLDEST. |
| Tool call args | `function_call.arguments` (JSON string) / `custom_tool_call.input` (raw) | [critic] **Extract per tool, not wholesale:** `exec_command` -> `args.cmd` (string); `shell` -> `args.command` (string array, OLDEST); `apply_patch` -> `.input` (raw patch `*** Begin Patch`); `write_stdin` -> `args.chars` (skip when empty; treat session_id/yield_time_ms/max_output_tokens as control noise, not text). `write_stdin` is 63/460 function_calls and is its own known shape. |
| Tool result | `function_call_output` / `custom_tool_call_output`: `.output` | Always `.output` (never `content`, 394/394). OLDEST `function_call_output.output` = JSON string `{output, metadata}` -> unwrap via JSON.parse. MID/RECENT = raw string, sometimes `Chunk ID: <hex>` prefix. Unwrap rule: try JSON.parse; if object with `.output`, use it; else raw. |
| Web search query | `web_search_call.action.query` | `action` is a union: `{type:'search', query, queries[]}` or `{type:'open_page'}` (no query). **No call_id** (0/4) -> anchorable by eventHash only. |
| Anchor: call_id | `.payload.call_id` on `function_call` / `*_output` / `custom_tool_call` / `*_output` | Present on all tool records. Already keyed into `tool_call_spans` PK `(session_id, tool_call_id)`. web_search_call has none. |
| Session id | `session_meta.payload.id` | string; reader already reads it. Defaults to `unknown`. |
| Originator / source | `session_meta.payload.originator`, `.source` | originator: `codex_vscode | codex-tui | codex_exec`. [critic] source values: `cli | vscode | exec` \| `{subagent:{other:<name>}}` \| null(OLDEST). `source=='vscode'` corroborates `originator=='codex_vscode'` for IDE-wrapper detection. |

## 4. Build variance

CLI version is not a reliable discriminator: 0.35.0 (OLDEST, 2025-09), 0.128.0-alpha.1 + 0.128.0 (MID, 2026-05), 0.128.0 (RECENT, 2026-06). MID and RECENT share the string `0.128.0` yet differ in record population. **Dispatch on record shape, never on `cli_version`.**

- `user_message` payload: OLDEST `{kind,message,type}`; MID/RECENT `{images,local_images,message,text_elements,type}`. `.message` stable; siblings empty.
- assistant `phase`: absent OLDEST; commentary/final_answer MID/RECENT.
- tool name + arg key: OLDEST `name='shell'`, `command`=string array; MID/RECENT `name='exec_command'`, `cmd`=string, plus `write_stdin`, plus `custom_tool_call`/`apply_patch`.
- patch mechanism: OLDEST has NO apply_patch/custom_tool_call (patches via shell heredoc, invisible as a tool); MID/RECENT `custom_tool_call.input` = raw patch; `patch_apply_end` (.changes unified_diff) MID-alpha-only.
- `function_call_output.output`: OLDEST JSON-wrapped; MID/RECENT raw string (+`Chunk ID:`). `custom_tool_call_output` stays JSON-wrapped.
- reasoning: OLDEST plaintext (`agent_reasoning.text` + `reasoning.summary[].text`, 40 records); MID/RECENT `encrypted_content` only, summary empty, RECENT drops the `content` key.
- developer role: absent OLDEST; present MID/RECENT.
- `turn_id` / `task_started` / `task_complete`: absent OLDEST; present MID/RECENT (on event_msg, never response_item).
- `session_meta`: OLDEST `{git, instructions:null, no base_instructions/source/model_provider}`; MID `{base_instructions{text}, source, model_provider, no git}`; RECENT all. `base_instructions` is an object `{text}`, not a bare string.
- `guardian_assessment` / `error` / `compacted` / `web_search_end`: MID-only (or MID-mostly).
- subagent sessions: `source.subagent.other='guardian'` MID/RECENT; OLDEST source null.

**`codex-reader.ts` assumptions that break or are incomplete for S2:**

1. The reader drops all conversation text by design (no `message`/`reasoning` branch). Adding the content projection over the same fold is S2's central job, not a break.
2. It silently skips unknown record types, which ADR-0007 forbids. S2 must count+surface. Currently-unhandled present types: agent_message, exec_command_end, patch_apply_end, guardian_assessment, task_started/complete, error, web_search_end, thread_name_updated, token_count, top-level `compacted`, turn_aborted, agent_reasoning. Most are correctly not content, but must still be counted, not dropped.
3. The docblock premise "patch text is always available" is false for OLDEST (patches are shell heredocs, no `custom_tool_call.input`), so file churn is invisible in OLDEST. No era-portable patch-content source exists for OLDEST.
4. `currentModel`/`currentCwd` key off `turn_context`, which has no `turn_id` in OLDEST. Fine for model/cwd, but the content path must not assume `turn_id` for ordering or segmentation.
5. `web_search` self-pairing by `webSearchSeq` is the precedent S2 reuses for un-id'd content ordering.

## 5. Anchoring and assignment scoping

ADR-0008: `AnchorRef = {eventHash} | {sessionId, toolCallId}`. `eventHash` = lowercase-hex of the BLOB `events.event_hash` (sha256 over canonicalJson, `src/hash.ts`).

- **Tool chunks (args + output):** `{sessionId, toolCallId}`. Clean and already supported; every tool record carries `call_id`, the reader already mints spans, `tool_call_spans` PK is `(session_id, tool_call_id)`. No new id.
- **Web search:** `{eventHash}` only. `web_search_call` has no call_id in any era; anchor by the eventHash of the reader's self-paired web_search span.
- **Human prompt:** `{eventHash}` of the reader's `user_prompt` event. Works, but fragile: `codexUserPrompt` emits `attributes:{}`, so the hash differs only by timestamp/model/cwd. Two same-millisecond prompts hash-collide and `INSERT OR IGNORE` drops the second. Zero collisions in today's corpus, but a latent producer-side risk (open question).
- **Assistant answer:** **no anchor target today.** No structural event, no call_id/turn_id/id, and assistant+reasoning records routinely share a timestamp. This is the single biggest content-side gap (open question).
- **Ordering:** use **file line index, not timestamp.** Verified collisions exist (reasoning+assistant share a timestamp; 25 collision groups in the big MID file; multiple function_calls in one millisecond). Assign each chunk a per-session monotonic sequence from line order, mirroring the existing `webSearchSeq`. Deterministic and re-render-stable for an append-only file.
- **Assignment scoping:** trivially by `sessionId` now. ADR-0008's assess spine writes one whole-conversation assignment; every AnchorRef is session-rooted, so all content chunks foreign-key to it with no per-chunk decision. Future #22 segmentation needs ordered turn boundaries: MID/RECENT supply `turn_id` + task_started/complete; OLDEST supplies neither, so #22 degrades to user_prompt-delimited line ranges there. S2 bakes in no `turn_id` dependency.

## 6. Fail-closed handling (ADR-0007)

Recognize each record by shape (`type` + `payload.type` + a small key signature), parse known shapes, quarantine malformed load-bearing records, skip-but-count-and-surface unknown types.

- **Recognize-by-shape for content:** `message` discriminates on `role` (unknown role -> quarantine, it is a conversation turn); content parts discriminate `part.type` (`input_text`/`output_text`; a never-seen part type counts as unknown content-part, no fabricated text); `function_call_output` unwraps by try-parse (handles the OLDEST-vs-MID/RECENT fork without keying on version); `error.message` is a recognized non-content shape.
- **Exclude-by-type as policy fail-closed:** `reasoning` and `agent_reasoning` are dropped by record type unconditionally, never by "is the text readable." OLDEST exposes plaintext reasoning, so dropping only encrypted reasoning would leak private CoT.
- **Unknown handling:** an unseen record type is skipped, but its `(type, payload.type)` is counted and surfaced (the ADR-0007 mechanism). Benign new auxiliary records do not fail a readable transcript; vendor drift stays visible. A known load-bearing content record whose fields do not match a parseable shape is quarantined and surfaced, never best-effort parsed.
- **Injection filter, fail-closed toward exclusion:** when classifying a user-role message, default to exclude unless positively recognized as engineer prose. [critic] Apply whenever `session_meta.originator=='codex_vscode'` or `source=='vscode'`, in **every era** (not OLDEST-only). Forcing markers (on the joined content text): leading `# Context from my IDE setup:` (extract tail after `## My request for Codex:` if present, else exclude), `<environment_context>`, `# AGENTS.md instructions`, `The following is the Codex agent history` (guardian replay). Subagent sessions (`session_meta.source.subagent.other` present) flag the whole session non-human; OLDEST source null defaults to non-subagent. [critic] Verified: the 4 markers partition all 73 `response_item` user records cleanly (29 IDE_WRAPPER + 28 GUARDIAN_REPLAY + 6 AGENTS_MD + 3 ENV_CONTEXT + 7 GENUINE), zero false-includes, on the joined text.
- **Truncation, honest over tidy:** tool output is truncated head+tail to a budget; truncated content is marked as elided, never silently emptied, so the judge distinguishes "large output elided" from "no output."

## 7. Reuse vs extend (the build plan)

S2 is an extension of the single existing reader (`codex-reader.ts` + shared vocabulary `translators/codex-events.ts`), not a new reader, per ADR-0007.

**Reuse as-is:** `parseLine`, the fold loop, session_id/model/cwd tracking, `lastTimestamp`, `toolNameByCallId`; the call_id -> tool span identity and `tool_call_spans` PK; exported `applyPatchFilePaths`; `rolloutSkillName`/`readSkillName`; the `webSearchSeq` precedent for un-id'd ordering; `src/hash.ts` eventHash + `store.ts` events PK (content references anchors, never copies).

**Extend (new code, all inside the one reader/module):**

1. A content-projection output alongside the structural `RegimenEvent[]` (a sibling product from the same fold, or a sibling exported function over the same parsed lines). Each chunk: `{kind: human_prompt | assistant_answer | tool_args | tool_output | web_search_query, text (referenced, post-truncation), anchor: AnchorRef, lineSeq}`. Referenced by anchor, never stored.
2. New `response_item` branches the reader lacks: `payload.type=='message'` (role user/assistant/developer) and `payload.type=='reasoning'`. assistant -> chunk; user -> injection-filter then chunk; developer + reasoning -> recognized-and-excluded (not silently skipped).
3. `function_call_output` / `custom_tool_call_output` now also yield content (try-parse-then-`.output` unwrap + truncation), with [critic] per-tool arg extraction for the call side.
4. The injection classifier (leading-marker + originator/subagent detection) and the vscode `## My request for Codex:` extractor.
5. Replace the reader's silent skip of unknown types with ADR-0007 count+surface + quarantine-load-bearing, covering structural and content paths in one place.
6. (Pending the open question) a new `codexAgentMessage` structural event in `codex-events.ts` so assistant text gets an `{eventHash}` anchor. This is the only change touching the shared vocabulary; do it producer-first (refactor+verify `codex-events.ts` before any consumer reads it), per producer-before-consumer.

## 8. Fixtures

A diverse set covering the variance, for the TDD build. Capture small files whole; slice the large ones.

1. **OLDEST 0.35.0 regression** (whole, 268KB): `2025/09/15/rollout-...-de1318e1-....jsonl`. The only plaintext-reasoning leak case (40 `agent_reasoning` + readable `reasoning.summary`, both dropped by type), `name='shell'` `command[]` array args, `user_message {kind,message,type}` with IDE wrapper + `## My request for Codex:` tail, no phase, no developer role, no turn_id, no custom_tool_call, JSON-wrapped `function_call_output`. Locks every assumption newer builds break.
2. **RECENT 0.128.0 clean baseline** (whole, 65KB): `2026/06/03/rollout-...-019e8c20-....jsonl`. codex_exec; assistant with phase=commentary AND final_answer (7/7 byte-identical to the agent_message twin), encrypted-only reasoning, base_instructions{text}, developer permissions record, raw exec_command output, clean human user_messages. The single-source/dedup + phase-metadata fixture.
3. **MID guardian/exclusion** (slice, first ~5 user/assistant pairs; do NOT capture the 889KB whole): `2026/05/03/rollout-...-019def0b-....jsonl`. `source.subagent.other='guardian'`, `The following is the Codex agent history...` replays, assistant `{"outcome":"allow"}`. The must-exclude / must-not-double-count subagent fixture.
4. **MID rich-tool + variance** (targeted jq slices; do NOT capture the 2.6MB whole): `2026/05/03/rollout-...-019deccd-....jsonl`. exec_command function_call(cmd-string) + raw `Chunk ID:` output, custom_tool_call apply_patch(`*** Begin Patch`), patch_apply_end (.changes unified_diff, MID-only), the genuine ~1127-char engineer user_message with its IDE-wrapper prefix, a guardian_assessment two-shape pair, web_search_call both action variants, the ~40KB long-output truncation case.
5. **MID error/edge** (slice, 47KB): `2026/05/03/rollout-...-019dec96-....jsonl` for the `event_msg/error` nested-JSON 400 record, plus the sibling failed session `01-00-07` (2 error event_msg, 0 assistant output) for the empty-output edge.
6. **RECENT dev-box same-version-different-population** (whole, 52KB): `2026/06/03/rollout-...-019e8c15-....jsonl`. cli_version `0.128.0` identical to MID yet no guardian_assessment/patch_apply_end, exec_command_end nearly absent, reasoning with `content` key dropped. Proves shape-not-version recognition.
7. **Timestamp-collision ordering** (3-4 line synthetic-from-real slice): a reasoning + assistant message sharing one timestamp plus a same-timestamp function_call pair (RECENT 06:05:07 group). Locks line-order (not timestamp) as the ordering and anchor-uniqueness key.

## 9. Decisions (2026-06-14) and remaining defaults

**Resolved by the user:**

1. **Assistant anchor: add a new structural v1 event** (`codexAgentMessage`) to the shared `codex-events.ts`, so assistant text gets a clean `{eventHash}` anchor. Producer-first change.
2. **Prompt anchor: add a per-session sequence index now** to `user_prompt` attributes (and the new `agent.message`), making their hashes collision-proof within a transcript read. Producer-side, paired with decision 1.
3. **IDE wrapper: marked boundary.** Pass the whole vscode message but mark where the IDE boilerplate ends and the engineer's ask (`## My request for Codex:`) begins; do not silently strip.
4. **`guardian_assessment`: exclude from the judge's text** and route decision_source/risk_level/user_authorization to a deterministic Enforcement-fired evidence signal (anchored via `target_item_id==call_id`).

**Anchor-resolution design note (load-bearing, confirmed against the code).** The hook path stamps `timestamp = captured_at`; the rollout path stamps `timestamp = the record's own timestamp`. So the two capture paths already produce different `event_hash`es for the same moment (the hash covers the timestamp). Consequences the build and S3 must honor: (a) `{sessionId, toolCallId}` anchors resolve via the `tool_call_spans` PK regardless of capture path (verify `tool_use_id` == rollout `call_id`); (b) `{eventHash}` anchors (prompt, web_search, the new agent.message) resolve only against rollout-derived events, and since hooks never capture assistant text and the tailer is off by default, **`feedback assess` (S3) must insert the transcript's structural events when it reads content and anchor to those**; (c) the sequence index from decision 2 solves the real within-transcript collision (same-millisecond records do occur), not a cross-path one. The new attributes are rollout-reader-set optional fields on the shared builders; the hook translator omits them (additive, no hook-path or projection breakage; a new `agent.message` event_type is ignored by existing projections until one is added).

**Proceeding with these defaults on the rest** (revisit if the build surfaces a reason): (5) `user_instructions` excluded from the turn stream for now (re-add as scoped context only if assess needs it); (6) truncation budget head+tail with truncated content marked-as-elided, exact byte budget tuned at the assess step; (7) compaction `replacement_history` skip-and-count; (8) empty image surfaces skip until a real instance appears; (9) tool results from era-portable `response_item/*_output` only.

### Original open questions (for reference)

1. **Assistant anchor (most load-bearing).** Assistant text has no anchor target today. Either (a) add a new structural v1 event (e.g. `agent_message.point`) to the shared `codex-events.ts` so assistant text gets an `{eventHash}` anchor, accepting the change to the shared vocabulary and conversation-count assumptions; or (b) anchor assistant chunks coarsely to the nearest preceding tool span / user_prompt. **Recommend (a)** (cleaner, and Outcome/assessment will want to cite the AI's answer).
2. **User-prompt anchor fragility.** `codexUserPrompt` emits empty attributes, so its eventHash is timestamp-only and same-millisecond prompts collide (one dropped under INSERT OR IGNORE). No collisions today. Add a per-session prompt sequence index to `user_prompt` attributes now (producer-side change with migration implications) to make it collision-proof, or defer-and-track? Pairs naturally with (1) if we touch the producer.
3. **IDE-wrapper handling.** Every vscode user_message is prefixed `# Context from my IDE setup:` with the real ask after `## My request for Codex:`. Strip the wrapper and pass only the ask, or pass the whole wrapped message with a marked boundary? Stripping risks losing context the engineer relied on; not stripping risks the judge grading IDE boilerplate as prompt clarity. **Recommend marked boundary, not silent strip.** (Is `## My request for Codex:` a stable delimiter? Need more codex_vscode samples.)
4. **`guardian_assessment` ruling.** Exclude from the judge's text projection and route decision_source/risk_level/user_authorization to a deterministic Enforcement-fired evidence signal (anchored via `target_item_id==call_id`), or expose its rationale as an AI action? **Recommend exclude-from-text + evidence-signal.**
5. **Setup-context projectability.** `base_instructions` is clearly excluded (system prompt). Should `turn_context.user_instructions` (the engineer's persistent global prefs, AGENTS/CLAUDE.md-equivalent) be projectable as scoped judge-input context, or excluded as non-conversation setup? Genuine open call.
6. **Truncation budget.** Max single tool output ~40KB. What head/tail byte budget does the judge want, and confirm truncated content is marked-as-elided, not emptied.
7. **Compaction content.** `compacted.replacement_history` holds a full pre-compaction message snapshot. Skip-and-count (recommended, avoids double-counting projected turns) or ingest as the only record of rotated-out content? Single instance in corpus.
8. **Future image surface.** `images`/`local_images`/`text_elements` and `input_image` parts are empty across all 9 files. Handle now or fail-closed/skip until a real instance is captured?
9. **Tool-result source confirm.** Read result text from era-portable `response_item/*_output` (recommended) and forgo the richer-but-era-thin `event_msg/exec_command_end.aggregated_output`? Reading both double-counts one call_id.

## Appendix: critic verdict

Verdict: **sound-with-corrections**. Inventory complete (no missed record types), stream-authority call correct. The 5 corrections (folded in above, tagged [critic]): (1) IDE-wrapper is originator-scoped, not OLDEST-era-scoped (the `## My request for Codex:` delimiter appears in vscode files of every era: 3/5/21/39 records); (2) per-tool argument extraction, including `write_stdin` as its own shape with empty `chars`; (3) `thread_name_updated` is non-conversation metadata, not a dedup twin; (4) `session_meta.source` real values `{cli, vscode, exec} | {subagent} | null`; (5) `web_search_end` is an orphaned richer end-record, not a call_id twin of `web_search_call`.
