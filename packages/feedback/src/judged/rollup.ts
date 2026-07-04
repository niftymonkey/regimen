/**
 * The verdict-rollup read side: the DETERMINISTIC header (capability 1).
 *
 * A cross-conversation read over the per-conversation verdicts already in the
 * store. This module owns the source-of-truth NUMBERS: the count of judged
 * conversations and a per-signal value distribution, computed straight from SQL
 * over the judged set. The synthesis layer (a later slice) reads these numbers
 * plus the assessment prose and interprets them, but it never recomputes a
 * count: the model miscounts buckets, so every number the rollup reports comes
 * from here, never from the model (the SQL-vs-model split).
 *
 * Generalized per ADR-0017: the header is no longer only an Outcome tally. Every
 * always-on signal must be a trustworthy number for both consumers, so the
 * header groups the judged rows by `signal_name` and `value`, returning one
 * distribution per signal. Pure SQLite read: no Judge, no network, no writes.
 */
import type { Database } from "bun:sqlite";
import {
  listSessions,
  type SessionFilter,
  type SessionSummary,
} from "../sessions.ts";
import { readJudgmentDigest } from "./digest.ts";
import type { JudgeModelPort } from "./port.ts";

/** One bucket of a signal's distribution: a value and how many verdicts hold it. */
export interface SignalBucket {
  readonly value: string;
  readonly count: number;
}

/** One signal's value distribution across the judged set. */
export interface SignalDistribution {
  readonly signalName: string;
  readonly buckets: ReadonlyArray<SignalBucket>;
}

/**
 * The deterministic head of a verdict rollup: the total judged conversations and
 * a value distribution per emitted signal. Every number a rollup reports comes
 * from here.
 */
export interface RollupHeader {
  readonly totalJudged: number;
  readonly distributions: ReadonlyArray<SignalDistribution>;
}

/**
 * The derived Outcome values in ordinal order, worst to best (ADR-0017). The
 * outcome distribution lists present values in this order; any value outside it
 * (an old pre-re-sweep verdict, or a future vocabulary member) sorts after, by
 * name. Every other signal's buckets sort by value name.
 */
const OUTCOME_ORDER: readonly string[] = [
  "not-accomplished",
  "partial",
  "accomplished-under-heavy-correction",
  "accomplished-under-light-correction",
  "accomplished-cleanly",
];

/**
 * Select the judged conversations matching `filter`: the judged subset of
 * {@link listSessions}, symmetric with the sweep's unjudged selection (the sweep
 * keeps the unjudged, the rollup keeps the judged). Widening past harness/model
 * to the full `SessionFilter` gives the rollup its time window (`since`/`until`)
 * and outcome slice through the one resolver `listSessions` already owns, so no
 * time-filtering is reimplemented and `listJudgedSessions` never learns
 * since/until. `now` resolves the relative bounds. The single selection seam both
 * the header and {@link collectVerdicts} share, so their sets cannot diverge.
 */
export function selectJudged(
  db: Database,
  filter?: SessionFilter,
  now: () => number = Date.now,
): ReadonlyArray<SessionSummary> {
  return listSessions(db, filter ?? {}, now).filter((s) => s.judged);
}

/**
 * Read the deterministic header for the judged conversations matching `filter`.
 * Selection is {@link selectJudged} (the judged subset of `listSessions`), so the
 * header honors the same time window and slice as the verdicts it heads; the
 * distributions come from a single GROUP BY over the judged rows of exactly that
 * set. Every number here comes straight from SQL.
 */
export function rollupHeader(
  db: Database,
  filter?: SessionFilter,
  now: () => number = Date.now,
): RollupHeader {
  const sessionIds = selectJudged(db, filter, now).map((s) => s.sessionId);
  if (sessionIds.length === 0) return { totalJudged: 0, distributions: [] };

  const placeholders = sessionIds.map(() => "?").join(", ");
  // The writer supersede leaves only the latest run's rows in judged_signal, so
  // grouping the selected sessions' rows is the latest verdict per session.
  // json-decode each value to compare and report it plainly.
  const rows = db
    .prepare(
      `SELECT signal_name AS signal_name, value AS value, COUNT(*) AS n
         FROM judged_signal
        WHERE session_id IN (${placeholders})
        GROUP BY signal_name, value`,
    )
    .all(...sessionIds) as ReadonlyArray<{
    signal_name: string;
    value: string;
    n: number;
  }>;

  const bySignal = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const value = JSON.parse(row.value) as string;
    const buckets = bySignal.get(row.signal_name) ?? new Map<string, number>();
    buckets.set(value, row.n);
    bySignal.set(row.signal_name, buckets);
  }

  const distributions = [...bySignal.keys()].sort().map((signalName) => ({
    signalName,
    buckets: orderBuckets(signalName, bySignal.get(signalName)!),
  }));

  return { totalJudged: sessionIds.length, distributions };
}

/**
 * One judged conversation as the synthesis model's input: the identity a
 * citation traces back to (`sessionId`), its read-time slice (`harness`,
 * `model`), the two categorical reads the narrative leans on (`intent`,
 * `outcome`, each null when the run abstained), and the judge's assessment
 * `prose`. The full per-signal numbers stay in the deterministic header; a
 * Verdict carries only what the model interprets, never a count.
 */
export interface Verdict {
  readonly sessionId: string;
  readonly harness: string;
  readonly model: string | null;
  readonly intent: string | null;
  readonly outcome: string | null;
  readonly prose: string | null;
}

/**
 * Collect the judged conversations matching `filter` as the synthesis model's
 * input. Selection is the shared {@link selectJudged} (so the set is identical to
 * the header's), then {@link readJudgmentDigest} per session pulls the assessment
 * prose, the Outcome, the Intent, and the harness/model already recovered by that
 * digest's join. No new store access is invented, and no number is computed here:
 * the header owns every count, a Verdict carries only what the model interprets.
 */
export function collectVerdicts(
  db: Database,
  filter?: SessionFilter,
  now: () => number = Date.now,
): ReadonlyArray<Verdict> {
  const verdicts: Verdict[] = [];
  for (const session of selectJudged(db, filter, now)) {
    const digest = readJudgmentDigest(db, session.sessionId);
    if (!digest.judged) continue;
    const intent = digest.assignment.signals.find(
      (s) => s.signalName === "intent",
    );
    verdicts.push({
      sessionId: digest.sessionId,
      harness: digest.harness,
      model: digest.model,
      intent: intent?.value ?? null,
      outcome: digest.outcome?.value ?? null,
      prose: digest.assessment?.prose ?? null,
    });
  }
  return verdicts;
}

/**
 * Order one signal's buckets deterministically: the outcome distribution by the
 * worst-to-best {@link OUTCOME_ORDER} (unknown values after, by name), every
 * other signal by value name.
 */
function orderBuckets(
  signalName: string,
  counts: Map<string, number>,
): ReadonlyArray<SignalBucket> {
  const values =
    signalName === "outcome"
      ? [
          ...OUTCOME_ORDER.filter((value) => counts.has(value)),
          ...[...counts.keys()]
            .filter((value) => !OUTCOME_ORDER.includes(value))
            .sort(),
        ]
      : [...counts.keys()].sort();
  return values.map((value) => ({ value, count: counts.get(value)! }));
}

/**
 * The rollup synthesis prompt's version stamp. Distinct from the per-conversation
 * judge's PROMPT_VERSION: the rollup composes a different template (free-form
 * colleague-voice prose, no structured parse), so a change to its wording is
 * tracked on its own date-stamped stamp and recorded in the rollup's provenance.
 */
export const ROLLUP_PROMPT_VERSION = "2026-07-04";

/**
 * The interpretive half of a rollup: the model's patterns-and-remedies narrative
 * plus provenance. `prose` is free-form colleague-voice text, never parsed;
 * `judgeModel` is the model that answered (from the response, never
 * self-reported); `promptVersion` is the pinned {@link ROLLUP_PROMPT_VERSION}.
 * Carries no number: every count lives in the deterministic header.
 */
export interface RollupSynthesis {
  readonly prose: string;
  readonly judgeModel: string;
  readonly promptVersion: string;
}

/** The collected header and verdicts the synthesis interprets. */
export interface SynthesisInput {
  readonly header: RollupHeader;
  readonly verdicts: ReadonlyArray<Verdict>;
}

/** The synthesis seam: the injected model port, the one thing tests vary. */
export interface SynthesisConfig {
  readonly llm: JudgeModelPort;
}

/**
 * The binding voice, distilled from docs/regimen-voice-and-ux.md into the
 * synthesis system prompt. The doc is the source of truth; this is one of the
 * three surfaces it governs and must not drift from it. The numbers rule is the
 * SQL-vs-model split restated for the model: the counts arrive already tallied,
 * so the model translates them into plain language and never invents or restates
 * a raw count.
 */
const ROLLUP_SYSTEM = [
  "You are a sharp colleague across the desk from an engineer, reviewing how their AI coding sessions have gone. Speak the way a co-worker would say it aloud, never like a report.",
  'The numbers you are given are already counted. Translate them into plain language ("about two thirds", "four of the finished ones"); never recompute, restate, or invent a count, and never write counts-as-notation like n=9.',
  'Use zero internal vocabulary in your answer: no signal names, enum values, axis names, or version labels. Say "needed heavy correction from you" rather than any label.',
  "Write for someone one month into using AI at work. Assume no familiarity with judges, rubrics, or how any of this is built.",
  'Shortfalls get a neutral subject; only wins get "you". Praise ownership ("your instinct to test first is solid"); name the pattern, the session, or the practice for a shortfall, never the person, because responsibility is shared between the engineer and the AI.',
  'Remedies are "we", and recommendations announce themselves: "My recommendation is that we ..." anchored to a concrete action, with the outcome as the why-clause.',
  'Route blunt options through the reader\'s own judgment ("if you think you have been fine without it, retire it"), never critique them directly.',
  'Help, not homework: when something is missing, ask the specific question and bring a candidate answer; never end with "be clearer next time" in any phrasing.',
  'Offer capabilities plainly, without liability waivers: "Regimen can help you draft that if you would like, and you can choose whether to install it."',
  "Be terse. If a paragraph can be a sentence, make it a sentence.",
  'Leave no dangling threads: every pattern you flag but do not act on carries a resolution Regimen owns, not the reader\'s memory, for example "I have noted it; if next week shows it again I will raise it as actionable."',
  "Shape: open with how the stretch went in a sentence or two, name the recurring pattern behind the shortfalls and why it happened, give one labeled recommendation with an offer to help, then re-raise any watch item you are not acting on yet. You may reference specific conversations by their session id when it grounds a claim.",
].join("\n");

/** Render the deterministic header as given facts for the prompt (never recomputed by the model). */
function renderHeaderFacts(header: RollupHeader): string {
  const lines = [`judged conversations: ${header.totalJudged}`];
  for (const dist of header.distributions) {
    const buckets = dist.buckets.map((b) => `${b.value}=${b.count}`).join(", ");
    lines.push(`${dist.signalName}: ${buckets}`);
  }
  return lines.join("\n");
}

/** Render one collected verdict as a labeled input line the model interprets. */
function renderVerdict(verdict: Verdict): string {
  const slice = `${verdict.harness}/${verdict.model ?? "unknown-model"}`;
  const intent = verdict.intent ?? "unstated";
  const outcome = verdict.outcome ?? "unjudged";
  const prose = verdict.prose ?? "(no assessment)";
  return `- session ${verdict.sessionId} (${slice}), intent ${intent}, outcome ${outcome}: ${prose}`;
}

/** Build the user projection: the given-facts header, then the per-conversation verdicts. */
function buildRollupUser(input: SynthesisInput): string {
  return [
    "Here are the numbers, already counted. Do not recount them; translate them into plain language.",
    renderHeaderFacts(input.header),
    "",
    "Here are the per-conversation assessments (one line each; the session id is how a claim traces back):",
    ...input.verdicts.map(renderVerdict),
  ].join("\n");
}

/** The system and user text a rollup synthesis call sends the model. */
export interface RollupPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * The rollup synthesis prompt: the system rubric and the user projection over
 * one {@link SynthesisInput}. A pure function of its argument only: no clock,
 * no environment, no store or network access, so the same input always yields
 * byte-identical text. Exported so an eval harness can build the exact prompt
 * without also driving a {@link JudgeModelPort}.
 */
export function buildRollupPrompt(input: SynthesisInput): RollupPrompt {
  return { system: ROLLUP_SYSTEM, user: buildRollupUser(input) };
}

/**
 * Turn the collected header and verdicts into the colleague-voice narrative by
 * one call through the injected {@link JudgeModelPort}. Returns the model's prose
 * plus provenance; it computes no number (the header owns them) and does not
 * parse the response (the prose is free-form).
 */
export async function synthesizeRollup(
  input: SynthesisInput,
  config: SynthesisConfig,
): Promise<RollupSynthesis> {
  const response = await config.llm.complete(buildRollupPrompt(input));
  return {
    prose: response.text,
    judgeModel: response.model,
    promptVersion: ROLLUP_PROMPT_VERSION,
  };
}

/**
 * The verdict-rollup's JSON contract, the cross-conversation twin of a
 * JudgmentDigest. `header` is the deterministic source of truth for every number
 * and is rendered verbatim; `synthesis` is the model's interpretation, or null
 * when the corpus is empty. `filter` echoes what was rolled up so a consumer
 * knows the slice.
 */
export interface VerdictRollup {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly header: RollupHeader;
  readonly synthesis: RollupSynthesis | null;
  readonly filter: SessionFilter;
}

/** The orchestrator's config: the filter to roll up, the model seam, the clock. */
export interface RollupConfig {
  readonly filter?: SessionFilter;
  readonly llm: JudgeModelPort;
  /** Injectable clock: resolves the relative time window and stamps generatedAt. */
  readonly now?: () => number;
}

/**
 * Roll up the judged verdicts matching the filter into a header plus a
 * synthesized narrative. Computes the deterministic header, collects the
 * verdicts, and synthesizes over both. An empty corpus short-circuits to a
 * header-only digest with `synthesis: null` and makes NO model call, so a rollup
 * over zero judged conversations is free and never errors (mirroring the sweep's
 * nothing-to-judge path). The header is always the source of truth for numbers;
 * the synthesis never recomputes them.
 */
export async function rollupVerdicts(
  db: Database,
  config: RollupConfig,
): Promise<VerdictRollup> {
  const now = config.now ?? Date.now;
  const filter = config.filter ?? {};
  const header = rollupHeader(db, filter, now);
  const generatedAt = new Date(now()).toISOString();

  if (header.totalJudged === 0) {
    return { schemaVersion: 1, generatedAt, header, synthesis: null, filter };
  }

  const verdicts = collectVerdicts(db, filter, now);
  const synthesis = await synthesizeRollup(
    { header, verdicts },
    { llm: config.llm },
  );
  return { schemaVersion: 1, generatedAt, header, synthesis, filter };
}
