# Gemini capture hooks install project-level, diverging from the config-home install model

> Status: accepted (2026-06-21)

The four-harness readiness push assumed one install model for live capture: write Feedback's capture hook once into the harness's config home, and it fires for every session that harness runs on the machine. Codex, Claude, and Gemini all keep hooks in a config-home file under the same `nested-matcher-groups` shape, so the working assumption was that all three share that uniform install and only Copilot diverges (on hooks-file format, settled separately). Gemini turned out to break the assumption on a different axis, scope rather than format, and this ADR records where its capture hooks actually install and why.

Two facts about Gemini were already producer-confirmed before this decision (both in `docs/harness-divergences.md`): each hook group must carry both a `name` and a `matcher` field, which the existing planner emits for neither, and Gemini sanitizes the hook environment, stripping inherited variables like `REGIMEN_DATA_DIR` (harmless in production, which uses the default data dir, but it forces an isolated test to set the data dir inside the hook command). What remained open was scope: in the end-to-end gate, only a project-level `.gemini/settings.json` in the workspace was observed firing headless, while a user-level `GEMINI_CONFIG_DIR/settings.json` did not. That earlier observation was not cleanly isolated, so before committing to a project-level install (a real ergonomic regression from install-once) the question was settled with a controlled probe.

## The probe that settled it

The test held everything constant except hook scope. One isolated root (`home` config dir, `data` data dir, `work` scratch cwd), the seeded Gemini credentials copied in, the deliberate-bug fizzbuzz fixture, and a wrapper script that sets `REGIMEN_DATA_DIR` inside the command (working around the env sanitization) before exec-ing the capture hook. The user-level run wrote the `name`+`matcher` hook groups into `home/settings.json` (the config home) and fired `gemini -p --yolo` from `work`; the buffer stayed empty.

That empty buffer alone is ambiguous, because the run also hit the free-tier model quota and crashed mid-startup, so "no capture" could have meant "hooks do not fire at user level" or merely "the process died before any hook ran." A control disambiguated it: the project-level recipe (the same hooks written to `work/.gemini/settings.json` instead of the config home), run under the identical exhausted quota, captured three envelopes, `SessionStart`, `BeforeAgent`, and `SessionEnd`. So Gemini's lifecycle hooks fire before and around the model call and survive a quota crash; the user-level run's empty buffer is therefore a real negative, not a crash artifact. Under identical conditions, project-level fires and user-level does not. That is a clean scope answer independent of the quota noise.

## Decision

Gemini's capture hooks install project-level: into the workspace's `.gemini/settings.json`, in the `nested-matcher-groups` shape but with a `name` and a `matcher` on each group. Gemini does not join the uniform install-once-into-config-home model that Codex and Claude use. The structural hooks-file `format` in the harness contract stays `nested-matcher-groups` (the on-disk shape is unchanged); the divergence is scope plus the required `name`/`matcher`, recorded in `docs/harness-divergences.md`, not a new format.

This makes Gemini the second harness to break the uniform install path, on a different axis than Copilot: Copilot keeps config-home scope but uses a different file format (`versioned-command-leaves`, see the harness contract); Gemini keeps the format but moves to project scope. The Feedback judge/read path is unaffected by either, because it reads the on-disk transcript directly and never depends on how hooks were installed.

## Consequences

The honest cost is that a project-level install is per-workspace, not install-once. For Codex and Claude, one config-home write captures every session on the machine; for Gemini, capture must be wired into each workspace where the user runs `gemini`, or wired by a mechanism that reaches every workspace. This is a genuine ergonomic regression and the reason the question was worth a controlled probe rather than a guess.

The capture-install planner work this implies is deferred and is not part of recording this decision. The planner (`packages/feedback/src/cli/install/capture-hooks.ts`) today writes config-home, no-`name`, no-`matcher` nested hooks; teaching it to emit project-level `.gemini/settings.json` with `name`+`matcher` for Gemini is the follow-up build that this ADR authorizes but does not perform. The end-to-end gate script (`packages/feedback/scripts/e2e-gate.sh gemini`) already hand-builds the project-level `name`+`matcher` hooks, so it exercises the decided install shape; its full paid pass remains gated separately by two facts unrelated to this decision: Gemini writes its transcript to the real `~/.gemini/tmp` ignoring `GEMINI_CONFIG_DIR`, so the gate's judge face does not resolve from the isolated home, and the free-tier model quota caps headless runs. The capture-face behavior this ADR turns on, project-level fires and user-level does not, is what the probe established directly.

One mitigation path is left open, not chosen: if a Gemini extension or another global mechanism can register hooks that fire headless across workspaces, it would restore install-once ergonomics without changing this decision's project-level fallback. It was out of scope for the probe and is not assumed to exist.

## Considered options

- **User-level config-home install, uniform with Codex and Claude.** Rejected by the probe. A `name`+`matcher` hook group written into `GEMINI_CONFIG_DIR/settings.json` does not fire in headless `-p`, while the same group at project level does. The uniform model is not available for Gemini regardless of how the hooks are shaped.
- **Project-level `.gemini/settings.json` install (chosen).** The only scope observed firing headless. Accepts the per-workspace ergonomic cost as the price of capture actually running.
- **Drop live capture for Gemini and rely on the judge/read path alone.** Rejected. The transcript reader already gives Gemini a working judge path, but live capture is the real-time quantitative face of Feedback; dropping it would make Gemini a second-class harness on the dimension this push exists to deliver. The per-workspace install is a smaller cost than losing the capture face.
