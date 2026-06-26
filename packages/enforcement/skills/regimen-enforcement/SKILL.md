---
name: regimen-enforcement
description: "Help the engineer author and wire the single right deterministic mechanism from the full breadth of Enforcement (a pre-tool gate, a permission rule, a tool disablement, a sandbox, an output schema, a CI check, a pre-commit hook, a substitution) so the model's choice is removed. Use right after a Feedback pattern shows asking has failed and the engineer, or the Guidance respond-helper, decides the honest move is to remove the model's choice; if asking has not yet been tried, hand back to Guidance instead."
---

# regimen-enforcement: author the deterministic mechanism

Help the engineer respond to a Feedback pattern by removing the model's choice. This is the act beat on the Enforcement side: a recurring problem has surfaced, asking has already failed (the model kept doing it after being told not to, high correction cost), and the honest move is a deterministic mechanism the model cannot choose its way past. You help author and wire the single right mechanism from the full breadth of Enforcement, then point the engineer back to the see beat to confirm it worked.

Enforcement is one of two response levers; Guidance is the other. The cut is mechanism, not form: Guidance is asked-for and may be ignored, Enforcement removes the choice so the work cannot proceed until the mechanism is satisfied. Regimen points at the mechanism, it never supplies it: you help the engineer author their OWN rule, and ship no catalog of mechanisms. Propose, never auto-apply; act only on the engineer's explicit confirmation.

## Process

### 1. Read the pattern as a determinism need, not a gate

Restate the surfaced pattern in terms of what must become impossible and where in the work the determinism should sit: at the agent's tool call, at the environment boundary, at the output, at the integration boundary, or as a substitution that runs in place of the model. Do not jump to a pre-tool gate by reflex; the right boundary is the lightest one that actually closes the gap.

### 2. Run the reverse-handoff check first

Confirm the precondition before reaching for any mechanism: has asking actually failed? Read the correction-cost history (the same Feedback read that surfaced the pattern, or the Guidance hand-off that carried it in). If it does NOT show a tried-and-failed advisory history (this is a first occurrence, no advisory move has been made yet, or the correction cost is low), STOP and hand back to the Guidance respond-helper. A deterministic mechanism is not free (a gate is code to maintain, a sandbox changes the workflow, a CI check slows the pipeline), and over-reaching on a first occurrence is the failure mode this check prevents. Only proceed when asking has already proven insufficient, or when the need is inherently "this must never happen."

### 3. Classify the need to a group, then a mechanism

Map the need onto where the determinism sits, and pick the strongest mechanism the pattern needs and the harness supports:

- A specific bad **action** the model keeps taking -> a pre-tool gate (a hook that denies or conditionally allows a tool call) or a harness permission deny, depending on whether the rule needs custom inspection logic.
- A whole **capability** that should not exist -> tool disablement, or a sandbox / filesystem jail that walls off the environment.
- A malformed **output** -> a schema the harness enforces, or a content gate that scans the file being written (the em-dash case).
- A wrong result that should not **land** -> a CI check, a branch-protection / pre-merge rule, or a pre-commit hook.
- A step the model does inconsistently that a tool does reliably -> deterministic substitution (a formatter, a codemod, a generator runs the step; the model never had the choice).

Resolve every harness-specific fact from the harness contract on demand, never hardcoded: the pre-tool event name and the Gemini name+matcher quirk live in `GATE_PROFILES`; whether a harness exposes a permission config, a tool-disablement setting, a structured-output mode, or a stronger permission-decision hook (Codex's `PermissionRequest` over `PreToolUse`) is reasoned from the harness in play. Pick the strongest available surface, not reflexively the pre-tool gate.

### 4. Choose the scope, then author and wire (or recognize and point)

Pick scope from whether the rule is repo-specific or universal, the same project-vs-global cut Guidance makes. A repo rule lands repo-local in `.regimen/gates/` and wires into project-level settings (fires only in that repo); a global rule (the em-dash gate) lands per-engineer in `<configHome>/regimen/gates/` and wires into the config-home hook (fires everywhere). Create the directory on the engineer's confirmation; the gate body lands where its hook is registered so the wired path is always valid.

Then branch on the mechanism. v1 AUTHORS AND WIRES the pre-tool gates (a deny or conditional-allow gate, and the content gate): draft a `bun` TypeScript body that reads the harness payload on stdin, applies the engineer's specific check, and writes the shared deny shape (`hookSpecificOutput.permissionDecision: "deny"`), authored Windows-safe (forward-slash paths, no shell, no `jq`, so it runs under the one runtime Regimen requires on every OS); then wire it onto the harness's pre-tool event through the planner (which knows the per-harness event name and the Gemini quirk). For everything else (a harness permission rule, an output schema, a CI check, a pre-commit / pre-merge gate, a sandbox or tool disablement, a substitution), v1 RECOGNIZES AND POINTS: name the mechanism, the file or setting it lives in for the harness in play, and the concrete steps to put it in place, but do not author or wire it. There is NO emit: a denial is captured in the transcript as an `is_error` tool-result, so validation is the judge reading the captured conversation, exactly like Guidance (ADR-0014). Draft the body and the wiring and PROPOSE them; write the file and wire the hook only on the engineer's explicit confirmation.

### 5. Name the validation path

Close by telling the engineer how to confirm the mechanism earned its keep: re-run the same Feedback read (the see beat, `regimen-evidence` then `regimen-judgment`) after the mechanism has had a chance to fire, watching for the original pattern abating in the intent-plus-outcome read. A mechanism that the pattern keeps slipping past is mis-targeted or mis-wired; a pattern that abates is the mechanism working. There is no deterministic firing count to watch (no emit); the abating pattern in the conversation the judge reads is the signal. An unvalidated, cost-bearing mechanism that is never revisited is silent dead weight.

## Notes

- The reverse handoff is the mirror of the Guidance helper's forward handoff: Guidance hands forward when asking has failed; you hand back when asking has not yet been tried. Together they make the canonical escalation operational in both directions. Do not dress an advisory need as a gate to keep the move on your own side, and do not author a "gate" that only warns (that is advisory wearing a gate's clothes); an Enforcement mechanism must actually remove the choice.
- Points, does not supply: you author, draft, or name the engineer's OWN mechanism. The only reusable things in play are Regimen's own seams (the deny-shape convention, the wiring planner, the per-harness `GATE_PROFILES`), which are operator infrastructure, not lever content. The content of the mechanism is always the engineer's.
- On-demand and agent-mediated, never Clippy: this activates only when the engineer (or the Guidance hand-off) has established that asking failed and asks what deterministic move to make. It never volunteers a gate unprompted, and it never auto-installs one.
- Harness-agnostic: every step that touches a harness-specific fact resolves it from the harness contract or `GATE_PROFILES` on demand, never hardcoded, so the one skill holds for every harness. The strongest-surface-per-harness choice (PreToolUse versus Codex's `PermissionRequest`) is reasoned from the harness contract at authoring time, not from a fixed table.
- A determinism caveat: a harness pre-tool hook is a guardrail, not always a hard boundary (on some harnesses and shell paths a denied command can still reach the shell; Codex's `unified_exec` path can bypass `PreToolUse` on some builds). When the pattern needs a hard boundary, prefer the stronger surface the harness offers, or a mechanism further out (a permission deny, a sandbox, an integration gate).
