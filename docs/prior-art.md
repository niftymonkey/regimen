# Prior art

> External work that bears on Regimen's design. Each entry records what it is, why it matters to Regimen, and which part of the design it informs.

## Self-improving Claude Code skills (Karpathy-style auto-research loop)

https://www.youtube.com/watch?v=wQ0duoTeAAU

A walkthrough applying Andrej Karpathy's "auto research" idea to Claude Code skills. The loop: feed a skill test prompts, score the output against **binary assertions** (true/false checks such as "under 300 words"), and if the score falls short, rewrite `skill.md`, rerun, keep the change if the score improved or revert it, commit, and repeat unattended. It explicitly separates binary, automatable checks from subjective quality (tone, "compelling"), which it leaves to human judgment.

**How it relates to Regimen.** It is an automated version of the long arc applied to the Guidance lever: improving a skill from measured results. It is a candidate mechanism for the long-arc respond step, the open question of how a diagnosed pattern becomes a sharpened skill. And its binary-versus-subjective split mirrors Regimen's evidence-layer-versus-judgment-layer boundary; the video stops at the subjective wall, which is exactly where Regimen's LLM-as-judge picks up.

**Caveat.** Its loop tunes a skill against a hand-written eval suite, synthetic test prompts in a lab. Regimen's Feedback measures real captured conversations. The video is prior art for the mechanism, not for the data source.

**Informs:** the long arc, the Guidance lever, and the long-arc respond step (formerly an open question in `ARCHITECTURE.md`, now resolved in design as light assistance in [`PRD.md`](../PRD.md), though not yet built).
