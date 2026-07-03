# Enforcement package re-evaluation

Architectural plus over-engineering re-evaluation of `packages/enforcement`, read-only, no code changed. Scope: the lever lifecycle (author a gate, wire it into a harness, fire on a denied tool call, emit a `gate.denial` event, land it as Feedback evidence), what is load-bearing versus carried over from the standalone `regimen-enforcement` repo (ADR-0004 era), and the simplest target shape now that the monorepo dispatches in-process (ADR-0012) with Feedback as the center (ADR-0013). Every claim cites `file:line`.

> SUPERSEDED IN PART (2026-06-25): the `gate.denial` emit seam this report marks load-bearing (`denial-store.ts` plus `hooks/emit-denial.ts`) was later DROPPED after empirical validation that a denial already lands in the captured transcript as an `is_error` tool-result Feedback reads on every harness; see the CORRECTED note and DECISIONS in `plans/enforcement-respond-helper-design.md`. Kept unedited below as the original point-in-time report.

## 1. File map across the lever lifecycle (author, wire, fire, emit, Feedback)

The package splits cleanly into three layers: the GATES (the things that deny), the WIRING (the installer that puts them into a harness hooks file), and the EMIT SEAM (how a fired denial becomes a Feedback row). Here is each file and where it sits in the author-wire-fire-emit-land chain.

AUTHOR (the gate bodies, the "discipline" itself):

- `examples/rm-rf-gate.ts` (`132` lines): a TypeScript PreToolUse hook. Reads the harness payload from stdin (`rm-rf-gate.ts:85-89`), decides whether a Bash command is a recursive forced `rm` (`isRecursiveForcedRm`, `rm-rf-gate.ts:68-82`), writes the shared Claude/Codex deny shape `hookSpecificOutput.permissionDecision: "deny"` (`rm-rf-gate.ts:96-106`), then records by spawning the emitter as a subprocess with explicit flags (`rm-rf-gate.ts:112-126`). Harness label comes only from `REGIMEN_HARNESS`, no fallback (`rm-rf-gate.ts:110-111`).
- `examples/em-dash-gate.sh` (`44` lines): a POSIX shell PreToolUse hook. Extracts written content with `jq` (`em-dash-gate.sh:23-28`), greps for U+2014 (`em-dash-gate.sh:30`), and on a hit pipes the raw payload to the emitter with `--from-hook` (`em-dash-gate.sh:36-38`), then `exit 2` with the reason on stderr (`em-dash-gate.sh:40-41`).
- `examples/inline-message-guard.sh` (`51` lines): same shape; guards git/gh message commands against heredoc bodies (`inline-message-guard.sh:28-49`).

WIRE (the installer that lands gate commands into a harness hooks file):

- `src/install/gate-commands.ts` (`53` lines): the published catalog. `GATE_COMMANDS` maps each `GateId` (`rm-rf | em-dash | inline-message`, `gate-commands.ts:17`) to a builder that produces the shell command string, `REGIMEN_HARNESS=<harness> bun "<clone>/examples/rm-rf-gate.ts"` and the two `bash "..."` variants (`gate-commands.ts:28-53`). Each builder calls `assertSafeClonePath` before interpolating (`gate-commands.ts:35,42,49`).
- `src/install/clone-path.ts` (`34` lines): `assertSafeClonePath` rejects clone paths that would break out of the double-quoted shell context (`clone-path.ts:21-34`). Lives in its own file purely to avoid a circular import between `gate-commands.ts` and `gate-hooks.ts` (`clone-path.ts:1-7`).
- `src/install/gate-hooks.ts` (`428` lines): the pure planner. Given a parsed hooks file and a `GateContext` (`gate-hooks.ts:91-98`), it merges gate leaves onto the harness's pre-tool event (`planGateHooks`, `gate-hooks.ts:336-364`) or strips them (`planGateHooksRemoval`, `gate-hooks.ts:401-428`). It carries its own copies of the hooks-file types (`LeafHook`/`MatcherGroup`/`HooksFile`/`VersionedHooksFile`/`RegimenMarker`, `gate-hooks.ts:27-65`), a per-harness `GATE_PROFILES` table mapping each harness to its pre-tool event name and the Gemini name+matcher quirk (`gate-hooks.ts:84-89`), and both the nested-matcher-groups writer (`planNestedGateHooks`, `gate-hooks.ts:250-285`) and the Copilot versioned-leaves writer (`planVersionedGateHooks`, `gate-hooks.ts:293-324`).
- `src/harness.ts` (`21` lines): `resolveHarnessHome`, reads the contract's config-home env var, else `home/<defaultSubdir>` (`harness.ts:13-21`).
- `src/cli/index.ts` (`324` lines): the in-process command facade. `wireGates` (`cli/index.ts:156-194`) resolves the harness and hooks path (`resolveTarget`, `cli/index.ts:63-109`), computes the clone path (`clonePath`, two levels up from this file, `cli/index.ts:111-114`), reads the file, calls `planGateHooks`, warns if a shell gate is selected without `jq` (`warnIfShellGateMissingJq`, `cli/index.ts:133-140`), and writes. `unwireGates` (`cli/index.ts:208-243`) is the reverse. `install` (`cli/index.ts:265-284`) and `uninstall` (`cli/index.ts:304-324`) are thin orchestrators over those, both of which short-circuit to a no-op on `win32` (`cli/index.ts:268-273`, `cli/index.ts:307-312`).

FIRE then EMIT then LAND (the store-write seam):

- `hooks/emit-denial.ts` (`116` lines): the harness-agnostic emitter the gates call. Parses flags (`emit-denial.ts:61-72`), optionally reads the hook payload from stdin under `--from-hook` filling `session`/`tool`/`tool-call-id`/`model` from it (`emit-denial.ts:74-80`), guards on required fields (`emit-denial.ts:85-93`), and appends the built line (`emit-denial.ts:95-106`). Exits 0 unconditionally and swallows all errors so a recording failure never breaks the gate's deny (`emit-denial.ts:107-110,113-116`).
- `src/denial-store.ts` (`94` lines): the seam itself. `buildGateDenialLine` builds the v1 `gate.denial` event per Feedback's store-write contract (`denial-store.ts:63-81`), using `traceIdFor` from shared (`denial-store.ts:71`). `appendGateDenial` mkdir-p's `<dataDir>/buffer` and appends one JSON line to `current.jsonl` (`denial-store.ts:90-94`). It re-exports `asHarness`/`resolveDataDir`/`dataDir` from shared (`denial-store.ts:30`) so a gate resolves both through one import.

The chain: the installer (`cli/index.ts` -> `gate-hooks.ts` -> `gate-commands.ts`) bakes `REGIMEN_HARNESS=<h> bun/bash "<clone>/examples/<gate>"` into the harness hooks file. At session time the harness runs that command on a pre-tool boundary; the gate body (an `examples/*` file) decides, writes the deny, and on a hit spawns `hooks/emit-denial.ts`, which calls `denial-store.ts` to append one line into Feedback's buffer. Feedback's loader drains that line into the SQLite store, where it becomes evidence in the same trace as the session's capture events (the `trace_id` derivation is shared, `denial-store.ts:71`).

## 2. Why each piece exists; load-bearing versus legacy

LOAD-BEARING (the actual lever):

- `denial-store.ts` and `hooks/emit-denial.ts`: this is the lever's real value, the only thing that makes a denial observable in Feedback without importing Feedback. The "reproduce the contract, do not import the row type" stance (`denial-store.ts:1-13`) is the deliberate seam from ADR-0005, and it is correct: it keeps the buffer format open to any producer. Keep both.
- `examples/rm-rf-gate.ts`: the reference gate and the fixture the emitter integration test drives (`rm-rf-gate.ts:8-11`). It is the canonical demonstration of the author pattern. Load-bearing as an example; whether the SHELL examples need to coexist is the Windows question (task 5).
- `gate-hooks.ts` planner and `gate-commands.ts` catalog: load-bearing in FUNCTION (the wiring must happen) but heavily DUPLICATED in form (task 3). The function survives; the implementation is a near-clone of Feedback's.
- `src/cli/index.ts` `install`/`uninstall`: load-bearing as the entry the unified CLI dispatches to. `enforcementInstall`/`enforcementUninstall` are the only two symbols `packages/cli` imports (`packages/cli/src/cli/index.ts:46-50`).

LEGACY or near-legacy (carried over from the standalone repo, now lower value):

- `src/cli/index.ts` `wireGates`/`unwireGates` AS A PUBLIC SURFACE: these are no longer a user-facing verb. ADR-0012 explicitly demoted `wire-gates` to an internal step of `regimen install` (`docs/adr/0012-...:` "the wiring verbs ... become internal steps"). The unified CLI never imports them; a grep for `wireGates`/`unwireGates` outside the package returns nothing (only `packages/cli/src/cli/index.ts` imports from `@regimen/enforcement`, and it imports only `install`/`uninstall`/`GateId`). They are still CALLED internally by `install`/`uninstall`, so they are not dead code, but their EXPORT and their separate documented command surface (`README.md:23-30`) is a multi-repo fossil: in the old standalone repo `bun src/cli/index.ts wire-gates` was the product's entry point; here it is an implementation detail of one function.
- `src/harness.ts` `resolveHarnessHome`: a byte-for-byte duplicate of Feedback's (task 3).
- The `package.json` `exports` pointing at `src/cli/index.ts` as both `types` and `default` (`package.json:6-11`) and the README's standalone install instructions (`README.md:20-30`) describe a package meant to be run on its own. That framing is legacy; the package is now only ever called in-process by `packages/cli`.

## 3. Legacy and redundancy hunt (monorepo, in-process CLI)

CLONE-PATH RESOLUTION. Enforcement computes the clone path as `join(import.meta.dir, "..", "..")` (`cli/index.ts:111-114`). Feedback computes the identical thing as `resolve(import.meta.dir, "..", "..")` (`packages/feedback/src/cli/index.ts:839`, `:690`, `:1058`). Both are "the package root, two levels up from the cli file." Now that both packages live in the same monorepo at a fixed relative layout, this is a candidate for a single shared helper. Lower-impact than the planner duplication, but it is real and it diverges subtly: Feedback uses `resolve`, Enforcement uses `join`.

IS `src/cli` (wire-gates/unwire-gates) A REAL SURFACE? No, not as a command surface. The unified CLI dispatches in-process and imports only `install`, `uninstall`, and the `GateId` type (`packages/cli/src/cli/index.ts:46-50`). `wireGates`/`unwireGates` are exported but consumed only internally by `install`/`uninstall` (`cli/index.ts:275`, `:316`) and by the package's own tests. The README still documents them as a runnable surface (`README.md:23-30`); ADR-0012 says they are not. The file is correctly named `src/cli/index.ts` but it is no longer a CLI, it is a library facade, and its own docstring already admits this ("each command is an exported library function ... the surface the unified `regimen` CLI dispatches to in-process", `cli/index.ts:1-6`). The `src/cli/` directory path is the leftover; the code inside is a facade.

HARNESS AND CONTRACT LOGIC DUPLICATED VERSUS SHARED. The shared package already owns the harness identity set, the resolver policy, the contract data, and the data-dir/trace helpers (`packages/shared/src/index.ts:9-23`). Enforcement correctly imports all of those. But two things are duplicated against FEEDBACK, not against shared:

1. `resolveHarnessHome` is identical in `packages/enforcement/src/harness.ts:13-21` and `packages/feedback/src/harness/support.ts:71-79`. Same signature, same body (read `contract.configHome.envVar`, else `join(home, contract.configHome.defaultSubdir)`). This is pure, contract-driven, and shared-eligible: it belongs in `@regimen/shared` beside `harnessContract`, and both consumers should import it. Two copies exist only because the two packages were separate repos.

2. The ENTIRE hooks-file planner is a "scoped clone" of Feedback's capture planner, and the code says so: `gate-hooks.ts:8` ("Scoped clone of Feedback's capture+gate planner, GATES ONLY"). Compare:
   - `gate-hooks.ts:27-65` defines `RegimenMarker`/`LeafHook`/`MatcherGroup`/`HooksFile`/`VersionedHooksFile`. `packages/feedback/src/cli/install/capture-hooks.ts:34-72` defines the SAME five types, near-verbatim, differing only in the marker's `role` doc.
   - `gate-hooks.ts:154-158` `stripGates` versus `capture-hooks.ts:125-129` `stripRegimen`: same map-filter-filter, differing only by `isGateLeaf` (role `"gate"`) versus `isRegimenLeaf` (role `"capture"`).
   - `assertWellFormed`/`assertVersionedWellFormed` (`gate-hooks.ts:165-204`) mirror Feedback's well-formedness guards.
   - `planNestedGateHooks`/`planVersionedGateHooks` (`gate-hooks.ts:250-324`) mirror Feedback's `planCaptureHooks`/`planVersionedCaptureHooks`.

   The only genuine difference is the role string (`"gate"` versus `"capture"`) and that Enforcement carries its own `GATE_PROFILES` table for the pre-tool event name and Gemini's name+matcher need (`gate-hooks.ts:79-89`), the analog of Feedback's descriptor `groupDecoration`. So roughly 300 of the 428 lines of `gate-hooks.ts` are a second copy of logic Feedback already owns. This is the single largest redundancy in the package.

## 4. Ponytail lens: what to delete, simplify, or replace, ranked

Ranked by impact (lines removed times risk removed), YAGNI-first.

1. DEDUPE THE HOOKS-FILE PLANNER (biggest). Extract one parametric hooks-file merge engine that takes a role (`"capture"` versus `"gate"`), the event(s) to wire, the leaf builder, and the group-decoration rule, then have BOTH Feedback capture and Enforcement gates call it. The two planners differ only in role string, which event they target, and the decoration table. This collapses ~300 duplicated lines (`gate-hooks.ts:27-324` against `capture-hooks.ts:34-...`) into one shared module plus two thin callers. The shared `HooksFormat` already lives in shared (`packages/shared/src/harness/contract.ts:45`); the planner types (`LeafHook`/`MatcherGroup`/`HooksFile`/`VersionedHooksFile`/`RegimenMarker`) should move to shared too, since both instruments and any future lever need them. This is the highest-value change and it directly serves the Guidance-mirroring goal (task 6): a future Guidance lever that wires an MCP server or a config line would call the same engine.

2. MOVE `resolveHarnessHome` TO SHARED, delete both copies. `harness.ts:13-21` and `feedback/src/harness/support.ts:71-79` collapse to one import. Trivial, pure, zero risk, removes a whole file from Enforcement.

3. SHARE THE CLONE-PATH HELPER. One `cloneRoot(importMetaDir)` (or a fixed monorepo-root resolver) in shared, used by both Enforcement's `clonePath` (`cli/index.ts:111-114`) and Feedback's three call sites. Removes the `join` versus `resolve` drift and the repeated `"..","..""` magic.

4. COLLAPSE THE TEST OVERLAP. `cli-facade.test.ts` (`180` lines) and `cli.test.ts` (`490` lines) both import the SAME four facade functions (`install`/`uninstall`/`wireGates`/`unwireGates`) from `src/cli/index.ts` and both drive them in-process against a temp config home. `cli.test.ts:1-10` claims to cover "the subprocess argv path" but its imports (`cli.test.ts:22-29`) show it calls the facade directly, same as `cli-facade.test.ts`. The subprocess path it describes no longer exists (ADR-0012 deleted the bin). These two files should merge; the "argv/subprocess" framing in `cli.test.ts` is stale. Net: a few hundred test lines and a misleading docstring removed.

5. STOP DOCUMENTING `wire-gates`/`unwire-gates` AS A STANDALONE SURFACE. The README's `REGIMEN_HARNESS=codex bun src/cli/index.ts wire-gates` block (`README.md:23-30`) describes the multi-repo entry point. Either drop it or rewrite it as "internal step of `regimen install`," matching ADR-0012. Keep the functions (they are the seam `install` calls), drop the public framing.

6. DROP `--no-gates` plumbing IF UNUSED end-to-end. `wireGates` accepts an empty gate set and the CLI exposes `--no-gates` (`packages/cli/src/cli/index.ts:581`). This is fine and cheap; flag only if the trial never uses it. Low priority, listed for completeness, likely KEEP.

YAGNI note that is actually a KEEP: `clone-path.ts`'s shell-injection guard (`clone-path.ts:21-34`) looks like over-engineering for a path you control, but it guards a string interpolated into a double-quoted shell command baked into a hooks file, and the builders are a published export with no planner in front of them (`gate-commands.ts:19-26`). Keep it, but move it to shared alongside the deduped planner so the capture side (which interpolates the clone path into `bun <path>` too, `capture-hooks.ts:137-142`) gets the same protection. Feedback's `captureCommand` does NOT currently call it, which is an asymmetry worth closing.

## 5. Windows-first: the shell gates are the weak point

Today: two of three example gates are POSIX shell (`em-dash-gate.sh`, `inline-message-guard.sh`), one is TypeScript (`rm-rf-gate.ts`). And `install`/`uninstall` skip the whole gate step on `win32` (`cli/index.ts:268-273`, `:307-312`), so on native Windows Enforcement installs NOTHING. Meanwhile Feedback's CAPTURE is proven end-to-end on native Windows for all four harnesses, and it got there by being careful: `captureCommand` forward-slashes the joined path (`capture-hooks.ts:137-142`, `.replaceAll("\\", "/")`) so the command survives a POSIX-style shell on Windows. Enforcement's `gate-commands.ts` does NOT forward-slash (`gate-commands.ts:36,43,50`), so even the TS gate's baked command would carry backslashes on Windows.

Recommendation, in order:

1. PORT THE TWO SHELL GATES TO TYPESCRIPT. The em-dash check is a substring/codepoint scan (`em-dash-gate.sh:30`) and the inline-message check is two regexes (`inline-message-guard.sh:28,34`); both are trivially expressible in a `bun` gate that reads stdin, exactly like `rm-rf-gate.ts` already does. This removes the `jq` dependency entirely (the `warnIfShellGateMissingJq` preflight at `cli/index.ts:133-140` and the `SHELL_GATES` set at `cli/index.ts:38` then delete), removes `bash` as a runtime requirement, and makes all three gates run under the one runtime Regimen already requires (bun). It is the single change that most advances Windows-first parity, and it shrinks the package (no `jq` branch, no `--from-hook` shell plumbing dependence for these two).

2. FORWARD-SLASH THE GATE COMMAND PATHS. Apply the same `.replaceAll("\\", "/")` Feedback uses (`capture-hooks.ts:141`) inside the `GATE_COMMANDS` builders (`gate-commands.ts:36,43,50`). This is a one-line-per-builder fix and a prerequisite for un-skipping Windows.

3. UN-SKIP `win32` once 1 and 2 land. The `cli/index.ts:268-273` skip exists only because the gate commands were POSIX shell. With three bun gates and forward-slashed paths, gates can install on Windows the same way capture already does, closing the lopsidedness where capture works on Windows but its sibling lever does not.

Net: the Windows story is the clearest "mostly cruft on one axis" finding. The shell gates are a multi-repo-era convenience (a shell hook is the lowest-friction thing to drop into a hooks file) that now blocks the project's stated Windows-first goal.

## 6. Simplest correct target architecture, framed to mirror a parallel Guidance package

The target keeps Enforcement as the thin lever it should be and pushes everything generic into shared, so that `packages/guidance` can be a near-identical thin lever beside it. Each package is "the code Regimen ships to help you USE this lever."

Target shape for `packages/enforcement`:

- `examples/` (the gates): three TypeScript bun gates (`rm-rf`, `em-dash`, `inline-message`), no shell, no `jq`. THIS is the package's irreducible content: the discipline bodies and the deny decision. Author layer.
- `src/denial-store.ts` plus `hooks/emit-denial.ts`: the emit seam. THIS is the lever's reason to exist as a separate package: it knows how a DENIAL becomes a Feedback row. Keep, unchanged in spirit.
- `src/catalog.ts` (was `gate-commands.ts`): the data table of gate ids and command builders. The one thing only Enforcement knows. Keep.
- `src/profiles.ts` (was the `GATE_PROFILES` slice of `gate-hooks.ts`): the per-harness pre-tool event name and Gemini decoration. Enforcement's analog of Feedback's capture descriptor. Keep, but as small data.
- `src/facade.ts` (was `src/cli/index.ts`, renamed off the misleading `cli/` path): `install`/`uninstall` only, calling the SHARED planner with the gate role, catalog, and profiles. `wireGates`/`unwireGates` become private helpers inside it.

Pushed to `@regimen/shared` (used by BOTH levers and by Feedback capture):

- The hooks-file types and the parametric merge/strip/removal engine (from `gate-hooks.ts` and `capture-hooks.ts`).
- `resolveHarnessHome` (from both `harness.ts` files).
- The clone-root resolver and `assertSafeClonePath`.

GUIDANCE EQUIVALENT, piece by piece (the mirror). This is the test of the design: a Guidance lever (advisory skills, CLAUDE.md lines, MCP servers, ADR-0013) should be assemblable from the same parts.

- AUTHOR layer (`examples/` gates): the Guidance analog is the SKILL bodies / CLAUDE.md fragments / MCP server descriptors Regimen ships. Same role, different artifact. Feedback already ships a bundled skill, so this layer exists.
- WIRE layer (catalog + profiles + shared planner): Guidance installs into DIFFERENT targets (a skills directory at `<configHome>/<skillsSubdir>`, a CLAUDE.md, an MCP config), not the pre-tool hook event. So Guidance reuses the shared INSTALL discipline (idempotent, marker-stamped, surgical, dedup, removal) but with its own target resolver and its own "leaf" shape. The shared engine should therefore be parameterized over the TARGET FILE shape, not hardcoded to hooks.json; the hooks-file merge becomes one instance. Feedback's skill installer (`packages/feedback/src/cli/install/skill.ts`) is prior art that the shared layer should also absorb.
- EMIT seam (`denial-store.ts` + `emit-denial.ts`): NON-EQUIVALENT, and this is the important asymmetry. Enforcement emits its own evidence event (`gate.denial`) because a denial is a discrete, real-time act with no transcript footprint. Guidance has NO emit seam of its own: a skill firing or a CLAUDE.md line being read is not a discrete event Guidance records; its effect shows up in the CONVERSATION, which Feedback's capture already records, and is read out by the judge (ADR-0013's validate beat). So `packages/guidance` would have the author and wire layers but NOT the emit layer. That is the correct, honest mirror: Enforcement is deterministic and self-reports its acts; Guidance is advisory and leaves its trace only in the conversation Feedback already watches.
- FACADE (`install`/`uninstall`): identical shape, the unified CLI dispatches to `guidanceInstall`/`guidanceUninstall` in-process exactly as it does for enforcement (`packages/cli/src/cli/index.ts:46-50`).

So the mirror is: shared planner + author bodies + facade are common; the WIRE TARGET differs (hooks event versus skills dir / config file); and the EMIT seam is Enforcement-only. Designing the shared planner to be target-shape-agnostic is what makes `packages/guidance` cheap to add later.

## 7. Honest verdict

MIXED, leaning valuable-but-bloated. The package's CORE is genuinely load-bearing and well-designed: the emit seam (`denial-store.ts` + `emit-denial.ts`) is exactly the right "reproduce the contract, do not import Feedback" boundary, the gates demonstrate a clean author pattern, and the install is correctly surgical and marker-driven. None of that is cruft. The CRUFT is structural carry-over from the standalone-repo era: a ~300-line second copy of Feedback's hooks planner, a duplicated `resolveHarnessHome`, a duplicated clone-path resolution, a `src/cli/` directory and README that still present an internal facade as a standalone command surface, two heavily overlapping test files one of which documents a deleted subprocess path, and a Windows posture (POSIX shell gates plus a hard `win32` skip) that contradicts the project's Windows-first goal while the sibling capture path already works on Windows.

Smallest change that removes BOTH the legacy and the lopsidedness, in order of value:

1. Extract ONE shared, role-parameterized hooks-file planner (plus the shared types, `resolveHarnessHome`, the clone-root resolver, and `assertSafeClonePath`) into `@regimen/shared`; make Enforcement's gate planner and Feedback's capture planner thin callers. This deletes the largest duplication and is the prerequisite that makes a parallel Guidance package cheap.
2. Rewrite the two shell gates as TypeScript bun gates, forward-slash the gate command paths, and un-skip `win32`. This deletes the `jq` dependency and the shell-gate preflight, and closes the capture-works-on-Windows-but-gates-do-not lopsidedness.
3. Rename `src/cli/` to a facade, demote `wireGates`/`unwireGates` to private, and fix the README and the stale `cli.test.ts` docstring to match ADR-0012. Merge the two overlapping CLI test files.

Items 1 and 2 are the substance; item 3 is cleanup. After all three, Enforcement is a thin lever (author bodies + catalog + profiles + facade + the emit seam) sitting on a shared install/contract spine, which is precisely the shape a parallel Guidance package would also take.

## Recommendations, ranked

1. Extract a shared, role-parameterized hooks-file planner into `@regimen/shared` and make `gate-hooks.ts` and `capture-hooks.ts` thin callers. Removes ~300 duplicated lines; highest impact; unblocks Guidance. (`gate-hooks.ts:27-324` versus `capture-hooks.ts:34-...`)
2. Move `resolveHarnessHome` to shared; delete both copies. Trivial, pure, zero risk. (`harness.ts:13-21`, `feedback/.../support.ts:71-79`)
3. Rewrite `em-dash-gate.sh` and `inline-message-guard.sh` as TypeScript bun gates; delete the `jq` dependency, `SHELL_GATES`, and `warnIfShellGateMissingJq`. Windows-first. (`em-dash-gate.sh`, `inline-message-guard.sh`, `cli/index.ts:38,133-140`)
4. Forward-slash the gate command paths and un-skip `win32` install/uninstall. Closes the capture-versus-gates Windows lopsidedness. (`gate-commands.ts:36,43,50`, `cli/index.ts:268-273,307-312`)
5. Share the clone-root resolver and `assertSafeClonePath`; have Feedback's `captureCommand` also validate the clone path. Removes `join`-versus-`resolve` drift; closes a validation asymmetry. (`cli/index.ts:111-114`, `feedback/.../index.ts:839`, `clone-path.ts`, `capture-hooks.ts:137-142`)
6. Rename `src/cli/` to a facade, make `wireGates`/`unwireGates` private, fix the README's standalone-surface block and `cli.test.ts`'s stale subprocess docstring, and merge the two overlapping CLI test files. Aligns with ADR-0012. (`src/cli/index.ts`, `README.md:23-30`, `cli.test.ts:1-10`, `cli-facade.test.ts`)
7. KEEP: `denial-store.ts`, `hooks/emit-denial.ts`, `examples/rm-rf-gate.ts`, the `GATE_COMMANDS` catalog, and the `GATE_PROFILES` data. These are the lever's irreducible value.

## Implications for the parallel Guidance package

- Guidance can be the same thin lever shape: author bodies (skills, CLAUDE.md fragments, MCP descriptors) + a catalog + per-harness profiles + an `install`/`uninstall` facade the unified CLI dispatches to in-process, exactly as it does for enforcement (`packages/cli/src/cli/index.ts:46-50`).
- The WIRE layer is the part that differs: Guidance installs into a skills directory (`<configHome>/<skillsSubdir>`) or a config file (CLAUDE.md, MCP config), not the pre-tool hook event. The shared install engine recommended above must therefore be parameterized over the TARGET FILE shape (hooks event versus skills dir versus config file), with the hooks-file merge as one instance; Feedback's existing skill installer is the second instance to absorb.
- The EMIT seam has NO Guidance equivalent, and that is correct. Enforcement self-reports a discrete `gate.denial` because a denial leaves no transcript footprint. Guidance's effect lives in the conversation, which Feedback's capture already records and the judge reads out (ADR-0013's validate beat), so a Guidance package would carry the author and wire layers but NOT a `denial-store.ts`/`emit-denial.ts` analog. Building the shared planner now, so the emit seam is the ONLY Enforcement-specific module left, is what makes that asymmetry clean rather than accidental.
