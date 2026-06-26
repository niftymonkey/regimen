---
name: regimen-guidance
description: "Help the engineer reach for the single right advisory move from the full breadth of Guidance (a standing-instruction line, a context doc, a memory edit, a skill, a slash command, a subagent, a prompt template, a checklist, an MCP server, a CLI tool, a retrieval source, a routing or output-style or scoping choice) so the model is asked to behave differently. Use right after Feedback surfaces a recurring pattern and the engineer asks what to do about it; if the correction-cost history shows asking has already failed, hand forward to the regimen-enforcement helper instead."
---

# regimen-guidance: reach for the advisory move

Help the engineer respond to a Feedback pattern by asking the model to behave differently. This is the act beat on the Guidance side: a recurring problem has surfaced, and where asking can plausibly work, the move is an advisory artifact the model is asked to honor and could still ignore. You help find, build, or reach for the single right move from the full breadth of Guidance, then point the engineer back to the see beat to confirm it worked.

Guidance is one of two response levers; Enforcement is the other. The cut is mechanism, not form: Guidance is asked-for and may be ignored, Enforcement removes the choice so the work cannot proceed until the mechanism is satisfied. Regimen points at the move, it never supplies it: you help the engineer locate or author their OWN move, and ship no catalog of moves. Guidance is per-harness and per-model, so the same Feedback pattern resolves to different moves depending on the CLI and the model in play. Propose, never auto-apply; act only on the engineer's explicit confirmation.

## Process

### 1. Read the pattern as a need, not a form

Restate the surfaced pattern in terms of what recurring behavior must change, and what the correction cost says about how hard asking has been. The intent-plus-outcome read names which intent of work this bites and where it lands; the correction cost is load-bearing: it tells you whether asking has been tried and failed or whether this is a first, cheap advisory move. Do not jump to a form yet, and do not default to a skill.

### 2. Run the mechanism check first

Confirm the precondition before reaching for any move: can asking plausibly work? Read the correction-cost history (the same Feedback read that surfaced the pattern). If it shows asking has ALREADY been tried and has not stuck (the model kept doing it after being told not to, high correction cost), or the need is inherently "this must never happen" rather than "the agent should prefer," STOP and hand FORWARD to the `regimen-enforcement` helper. Authoring a weaker advisory move for a pattern the model has already proven it will ignore is the failure mode this check prevents. Only proceed when asking can plausibly change the behavior.

### 3. Classify the need to a group, then a form

Map the need onto where the advice should live and how the agent should encounter it, then pick the cheapest durable form the Feedback pattern can later validate (a one-line standing instruction before a whole skill, a skill before a subagent), since beat 3 has to be able to tell whether the move worked:

- **Group A, standing context**: a small always-relevant rule the harness loads every turn. A `CLAUDE.md` / `AGENTS.md` instruction line, a focused subsection, a context-priming doc (`CONTEXT.md`, a glossary, an ADR set) the agent is pointed at, or a memory / persistent-context edit. Best for a stable tool preference, naming convention, "never do X" line, or recurring vocabulary or context drift.
- **Group B, invokable units**: a discrete named artifact the agent pulls in on demand. A skill, a slash command, a subagent, a prompt template, or a checklist / reference example. Best for a heavy or situational multi-step discipline the agent keeps skipping or doing inconsistently.
- **Group C, reachable capabilities**: a tool or source the agent is enabled and encouraged to use. An MCP server, a CLI tool, or a retrieval / docs source. Best for stale-information or "worked from guessed truth" drift.
- **Group D, process choices**: a durable decision about how work is run, expressed to the agent. Harness or model routing, an output-style or response-mode preference, or a scoping / decomposition habit. Best for one intent of work consistently going worse on this harness, a communication-shape complaint, or scope drift.

Use the harness and model in play to confirm the form exists on this harness (the instruction-file name, the skills location, whether slash commands or subagents are supported) and to weigh whether the problem is harness-specific or universal.

### 4. Decide find, build, or reach-for within the form

Once a form is chosen, enact it by one of three branches, and name which and how.

**Find** (the move already exists; locate and install it). Used most for the skill form. Shell the Vercel `skills` CLI directly, as a plain Bash command, distilling the pattern's need into keywords:

```bash
npx skills find <keywords>
```

This is a SOFT dependency: npx fetches the CLI transiently when node is present, and if npx is absent, there is no network, or the search returns nothing, fall straight to the build option (which is always the third presented option anyway, so there is no separate empty-result branch). Do NOT tap any harness-native skill-finder; that would not port across harnesses. EVALUATE the shortlist by fetching each candidate's `SKILL.md` frontmatter or skills.sh page to read the description, judging two things together: does it answer THIS pattern's need, and does it lean on harness-specific tools or slash conventions that will not port to the harness in play. PRESENT up to three options and install nothing until the engineer picks: the top found candidate (name, `owner/repo@skill`, install count, a one-line why-it-matches, and the exact `npx skills add <owner/repo@skill>` command); the second found candidate in the same shape; and "build one specific to your need" as a permanent first-class third option. Install scope defaults to global (a discipline skill is usually cross-repo), dropping to project scope only when the pattern is clearly repo-specific; the CLI handles per-harness agent detection. Never silent-install, and glance at what is already active (Feedback's `skillUsage`, or `npx skills list`) so you do not recommend installing something already present.

**Build** (no good existing move; author one with the LLM). Used when the discipline is specific to this engineer, this repo, or this pattern. Author the artifact with the LLM in the form's shape (a `SKILL.md` with frontmatter and a procedure, a subagent definition, a command, a checklist, a `CONTEXT.md` section), grounded in the surfaced pattern and the evidence anchors, then place it where the harness discovers it. Draft and propose; the engineer owns the authoring decision.

**Reach-for** (the move is a capability or a config edit, not an authored artifact). Used for MCP servers, CLI tools, retrieval sources, standing-instruction lines, memory edits, output-style settings, and routing decisions. Name the specific server / tool / source / config line / file edit, give the exact install-or-edit step and the scope (project versus global), and for a capability add the standing-instruction line that tells the agent when to prefer it. You point; the engineer or agent performs the edit.

Across all three branches, "Regimen points, does not supply" holds: you locate, draft, or name the move, and never ship a catalog of moves or install lever content as if it were Regimen's product.

### 5. Name the validation path

Close by telling the engineer how to confirm the move earned its keep: re-run the same Feedback read (the see beat, `regimen-evidence` then `regimen-judgment`) after the move has had a chance to act, watching the same intent-plus-outcome and correction cost for the original pattern abating. A move that does not move the pattern is dead weight to revisit. An unvalidated, cost-bearing advisory move that is never revisited is silent dead weight.

## Notes

- The forward handoff is the mirror of the Enforcement helper's reverse handoff: you hand forward when asking has already failed; it hands back when asking has not yet been tried. Together they make the canonical escalation operational in both directions (ask first; when asking does not stick, remove the choice). Do not dress an Enforcement need as a Guidance move to keep it on your own side, and do not author a weaker advisory move for a pattern the model has already proven it will ignore.
- Points, does not supply: you locate, draft, or name the engineer's OWN move. You carry no built-in catalog of skills, gates, or moves; even a reference example you name is a starter, not a fixed menu. The content of the move is always the engineer's; Regimen supplies only the operator skill that helps reach for it.
- On-demand and agent-mediated, never Clippy: this activates only when the engineer has just seen a pattern and asks what to do about it. It never volunteers a move unprompted mid-conversation, and it never auto-installs one; the trigger is always the engineer's, even when the answer surprises them.
- Harness-agnostic: every step that touches a harness-specific fact (the instruction-file name, the skills location, whether subagents or slash commands exist) resolves it from the harness contract or detection on demand, never hardcoded, so the one skill holds for every harness. Reuse the Feedback skills' `cwd`-resolution plus harness detection to know the harness and model in play; introduce no new mechanism. The harness- and model-specificity of the content it recommends is a property of the move it points at, not of the operator skill itself.
