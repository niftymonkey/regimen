# Regimen: The Problem and the Mental Model

> Shared-understanding artifact, captured 2026-06-23. This is the source of truth for what Regimen is *for* and the mental model behind it, aligned between the author and the assistant over a long working session. The README and other outward copy derive FROM this; this document optimizes for fidelity, not brevity. Each point is atomic with its rationale attached, so a later summary pass cannot blur two distinctions together. The wording here is the idea, not final copy.

## 0. How to use this document

- **It is the source, not the output.** The README is the compressed, skimmable output derived from this. Compression happens there, deliberately and visibly, never here. Do not shorten this document to make it more README-like.
  - **Why:** the nuance below was hard-won across many iterations and is exactly the kind of thing summaries squish. A faithful source means the README can be rewritten any number of times without re-litigating the model.

## 1. The thesis (kept)

- **AI's value in software engineering is conditional, not intrinsic.** And: what separates good software from slop is not the model, it is the engineer's process (how work is framed, how context is supplied, how output is verified, what is and is not handed to the agent). These two sentences are kept close to verbatim. They are the kernel.
  - **Why:** they are the one part of every prior README draft that consistently landed. They state the lever (process) without yet describing any machinery.

- **The lever is your process, framed as a multiplier, never as "the model does not matter."** Your process is what decides how much you get out of whatever model and harness you are working with.
  - **Why:** models and harnesses genuinely differ in quality, and you are allowed to prefer better ones. The claim is not that the model is irrelevant; it is that process is the part you control, and it determines how much of any model's capability you actually realize.
  - **Rules out:** phrasing like "the lever is your process, not the model," which over-extends the kept thesis into "models are equivalent." The kept thesis sentence survives because *there* "not the model" is specifically about what separates good output from slop, not a claim that models are interchangeable.

## 2. The problem (the corrected spine)

- **Today the whole thing runs on feel.** You carry impressions: whether a session went well, why, what you might change, whether a change helped. None of it is grounded in data.
  - **Why:** this replaces an earlier, wrong framing ("you can see the agent's side but not your own"). You do not actually *see* how the agent performed either; you have a feeling about it. It is feel across the board.
  - **Rules out:** any "you already know X, here is the Y you do not know" structure. There is no X you already objectively know.

- **Regimen turns the feel into data.** It is observability for your AI-assisted engineering: it makes the interaction between you and the agent inspectable instead of felt.
  - **Why:** this is the observability (OTel) instinct that started the project. Before observability you had a feeling your service was healthy; after, you had data. The gap between those two is the entire point.

- **The judged layer converts a feeling into a grounded read.** Intent (what you were trying to do) plus the outcome enumerations (accomplished-cleanly, accomplished-with-correction, partial, abandoned) turn "I think that went okay" into something named, comparable, and checkable.
  - **Why:** without this layer, "how it went" stays a vibe. The enumerations are what make two conversations comparable and a claim falsifiable.

- **Why it must be captured data and not "just pay closer attention": access and grounding, not incapacity.** Regimen does not presume you cannot see your own patterns. It gives you a straightforward, direct read instead of a guess. Sometimes that read confirms your hunch (valuable), sometimes it surprises you (also valuable).
  - **Why:** earlier framings ("you are the wrong instrument," "habits are invisible to you") kept implying the person is incapable, which makes readers defensive and is not the claim. OTel does not tell you that you could never have known your service was healthy; it just gives you the data, whether that data confirms or corrects.
  - **Rules out:** any wording that tells the reader they cannot perceive their own work, or that the data knows them better than they know themselves.

## 3. The line (what Regimen is allowed to say)

- **It measures the conversation, never the code, and never renders a verdict on you.** It also never judges anything else already declared out of scope.
  - **Why:** software quality is subjective and not Regimen's to adjudicate, and a tool that grades the person is the thing the author explicitly does not want, and that nobody else wants either.

- **What it surfaces is specific, localized, grounded, and actionable, never vague coaching.** It points at a concrete pattern and a concrete thing you could change, anchored in what actually happened. It would never say "get better at prompting."
  - **Why:** vague advice is useless and also slides toward judging the person. Grounded specificity is both more useful and stays on the safe side of the line.

## 4. The loop

- **The core measurable unit: "did the agent do what I wanted, and how much correction did that take?"** This is the Intent-plus-Outcome read; the outcome enumerations are the correction cost.
  - **Why:** it is concrete and answerable from captured data, and it is the atom both beats below operate on. It replaces the earlier, too-monolithic "is my kit serving me."

- **The loop is see, act, validate, a cycle and not a line.**
  - Beat 1, see: Regimen surfaces a pattern you would otherwise only feel.
  - Beat 2, act: you pull a lever, build or adjust a skill (Guidance) or add a gate (Enforcement). This is your move, not Regimen's.
  - Beat 3, validate: Regimen shows you whether what you built actually changed anything.
  - There is no beat 4. Beat 3 is itself a fresh observation, so it rolls back into beat 1.
  - **Why:** Regimen owns the seeing (beats 1 and 3); you own the acting (beat 2). That is the same statement as "Feedback is the center, the levers are your action."

- **Beat 1 is the heart, beat 3 is non-negotiable, roughly 51/49, both always present.** Beat 1 (knowing what change to make) is the genesis of the project. Beat 3 (knowing whether the change earned its keep) is required because levers are not free: a skill, a CLAUDE.md line, a hook, an MCP server all carry cost, so an unvalidated lever can be dead weight.
  - **Why:** the two beats are one question asked twice, not two features. Without beat 3, the act of improving your practice can silently degrade it. Do not force a choice between them; it is an AND.

- **It is an AND across time range, never an OR.** In the moment and over many conversations. One conversation and the trend across many. You move between the single conversation and the aggregate.
  - **Why:** both are genuinely valuable, and you navigate from one to the other (notice something in one conversation and check the trend, or spot a trend and drill into one conversation).
  - **Rules out:** describing this with OTel's nouns. "Span" and "dashboard" belong ONLY to the optional OTLP-bridge-into-Grafana path. Plain Regimen describes this in its own units: a conversation, and the trend across conversations.

## 5. The structure

- **Feedback is the center; Guidance and Enforcement are the levers you act with. Not three equal pillars.**
  - **Why:** Feedback is the observability, the reason the whole thing exists. Guidance and Enforcement are what you reach for in response to what Feedback shows (beat 2). This dissolves the old "three instruments cut by mechanism, picked up one at a time" framing and the loop diagram that mirrored it, both of which read as a wiring diagram rather than a use.

- **The levers are categories of response, not catalogs Regimen ships.** Guidance and Enforcement name the two kinds of move available in beat 2 (ask the model, or compel it). The actual contents (this skill, that gate) are the engineer's own. They emerge from the engineer's own Feedback, they are often subjective (the em-dash gate is one person's taste, not a universal), and they are often harness-specific (a non-issue on one CLI, a recurring problem on another).
  - **Why:** this sharpens the model, it does not threaten it. Feedback is the one thing Regimen genuinely delivers and that lives in this repo. The levers are conceptual slots the engineer fills with their own, frequently external, content. Much of that content does not live in this repo at all: Guidance skills come from the external `skills` repo (the author's own plus Matt Pocock's), from harness built-ins, and from wherever each engineer sources them, differing person to person by how each works with their model. What is universal about Guidance and Enforcement is the *concept of the move*, plus at most a few reference examples (the reference gates) offered as starters. The bundled Feedback skills are not examples of the Guidance lever; they are Regimen's own infrastructure, the way the agent reads Feedback in conversation.
  - **The repo already reflects the asymmetry.** Feedback is substantial here, Enforcement is a few reference gates plus the wiring to install them, and Guidance is essentially pointers outward. `ADR-0002` (the instrument names the category; the techniques live at the adapter edge) and the `PRD` (Guidance is skills generally; the curated repo is one source, not the canonical container) already gesture at this; the model states it outright.
  - **Rules out:** presenting the reference gates as "the toolkit you choose from." They are starters and examples of the move, never a fixed menu Regimen owns.

- **Each lever spans many forms; the cut is mechanism, not form.** Guidance is any advisory offering the agent is asked to use: a skill, a standing-instruction line (`CLAUDE.md` / `AGENTS.md`), an MCP server or CLI it can reach for, and more. Enforcement is any deterministic mechanism that removes the choice: a hook or gate, a permission boundary, a CI or pre-merge check, a sandbox, schema-constrained output. Skills and gates are the most visible instances, not the whole of either lever.
  - **Why:** describing Guidance as 'skills' and Enforcement as 'gates' under-sizes both and makes them feel deflated next to Feedback. The levers are the entire space of advisory and deterministic moves available to the engineer; what Regimen adds is not the content but the Feedback-driven read of which move is worth making, in either category. Consistent with `ADR-0002` (the cut is advisory versus deterministic) and with capability provisioning having been folded into Guidance rather than made a fourth instrument.

- **The kit is not one-size; it is per-model and per-harness.** The same way of working can serve you well with one model or harness and poorly with another, because they are built and trained differently. Telemetry lets you learn how each one responds to your process, from your own runs, then adjust your process per harness or choose the harness on evidence.
  - **Why:** this is why the store carries harness and model columns, and it lets you stop guessing from benchmark scores and blog posts. The earlier "trial a new CLI or model" framing returns here, not as a separate problem but as this same observability pointed across harnesses.

## 6. The protagonist

- **The same person, before and after.** Regimen opens the eyes of someone who did not realize their practice was leaving value on the table (beat 1), then keeps that now-active person honest about what they built in response (beat 3).
  - **Why:** it is the only protagonist framing that needs both beats, and it matches the two value stories the author tells back to back (elevate a pattern to someone who would not have noticed, then validate the change they make).

## 7. Canonical instances

- **work-router, the Guidance-lever instance.** A recurring, felt pattern (running a multi-threaded harness single-threaded, bloating the main conversation, the harness's parallelism unused) led the author to build a Guidance skill so the harness would volunteer the right behavior. Crucially, that skill's own design already names a dependency on "an automated feedback store" to know whether it is working, a hole shaped exactly like Regimen.
  - **Why:** it is the real origin story, and a skill literally waiting for "an automated feedback store" is the strongest possible proof that beat 3 (validate) is a genuine, felt need, not a theoretical one.

- **The em-dash hook, the Enforcement-lever instance.** The model kept dropping em-dashes into nearly every markdown file (the AI-slop smell, because nobody writes that way). Asking it to stop did not hold, so the author removed the choice with a hook.
  - **Why:** it illustrates the exact line between the levers (Guidance asks, Enforcement compels) and the natural escalation (try asking first; when asking does not stick, make it deterministic).

## 8. Constraints and honesty

- **Harness- and model-agnostic by construction.** Every artifact (schemas, event names, signals, interfaces, configs) holds for any agent CLI and any model; harness-specific detail is confined to a thin capture-edge adapter and normalized immediately.
  - **Why:** a measurement tied to one CLI is not comparable across the harnesses you actually want to compare, and you should never have to switch CLIs to adopt Regimen.

- **Honest about what is built.** Built today: the captured data over time, the slice-able history (`regimen list` by harness, model, time), and the optional Grafana view via the OTLP bridge. Not yet built: the over-time judged synthesis (trend rollups, comparison against your own past) and the respond-step suggestions (the "this keeps happening, here is the specific thing to build" assist).
  - **Why:** the over-time *interpretation* is the part outward copy must not overclaim; the over-time *data* genuinely exists.

## 9. Implications for existing docs

- **Some current artifacts trail this model and will need revision to match.** The README (all three drafts), the three-equal-pillars framing, and the loop diagram that mirrors it are the clearest examples. The DOMAIN-LANGUAGE pillar framing may also need a pass so "Feedback is the center, Guidance and Enforcement are levers" is reflected rather than "three instruments."
  - **Why:** this document is now ahead of the outward copy. Flagging the gap prevents a future reader from treating an older doc's framing as current.

## 10. Style discipline (for any copy derived from this)

- Use the project's precise vocabulary correctly (see `DOMAIN-LANGUAGE.md`), with the caveat in section 9 that the pillar framing itself is under revision.
- Never use an em-dash (U+2014) or an en-dash (U+2013) anywhere. Use commas, colons, parentheses, or two sentences.
- Do not hard-wrap prose; one paragraph is one line.
