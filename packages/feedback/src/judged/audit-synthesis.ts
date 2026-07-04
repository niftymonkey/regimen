/**
 * The leverage-audit synthesis layer: the model-driven prose over the
 * deterministic core (audit.ts). It never recomputes a number; it interprets the
 * per-practice liveness report the SQL read produced, and only when something is
 * actually wrong (an idle practice) does it consult the model for a deep-dive and
 * a labeled recommendation. Everything healthy is summarized deterministically
 * with no paid call, matching the design's "deterministic firing + snapshot +
 * convention-adherence + ON-DEMAND applicability": the model is the on-demand
 * part, spent only on a shortfall.
 *
 * The synthesis prompt is bound by docs/regimen-voice-and-ux.md: colleague voice,
 * zero internal vocabulary, neutral-subject shortfalls, wins get "you", remedies
 * are "we" and recommendations announce themselves. The acceptance fixture is
 * Scene 6 (md.niftymonkey.dev/v/pcEXdDxk): a per-lever health summary plus one
 * deep-dive where a lever is not being honored.
 */
import type { JudgeModelPort } from "./port.ts";
import type { LeverReport, LeverageAuditReport } from "./audit.ts";

/** The result of an audit synthesis: the prose and whether the model was paid. */
export interface AuditSynthesis {
  readonly narrative: string;
  /** True only when an idle practice forced the on-demand model deep-dive. */
  readonly modelConsulted: boolean;
}

/**
 * The synthesis system prompt, encoding the binding voice constraints from
 * docs/regimen-voice-and-ux.md verbatim in intent. Every rule here is load-bearing
 * for the deep-dive prose: breaking one is a voice-doc violation. Exported so the
 * tests can assert the constraints are present and so the one source of the audit
 * voice does not drift across surfaces.
 */
export const AUDIT_SYNTHESIS_SYSTEM = [
  "You are Regimen, reporting a leverage audit to the engineer whose practices you checked. Speak like a sharp colleague across the desk, not like a report. If a sentence would sound strange said aloud to a teammate, rewrite it.",
  "Write for someone one month into using AI at work: assume no familiarity with judges, rubrics, or Regimen's internals.",
  'Use zero internal vocabulary: no signal names, no enum values, no counts-as notation like n=9. Translate every number into plain language ("almost none of those sessions", not "fired in 0 of 9").',
  'Shortfalls get a neutral subject; only wins get "you". Praise is owned ("your TDD habit is solid"); a failure names the practice or the sessions ("that skill has not fired in weeks"), never the person, because in agent sessions responsibility is shared.',
  'Remedies are "we", and the recommendation announces itself: "My recommendation is that we ...", anchored to a concrete action, with the outcome as the why-clause.',
  'Route blunt options through the engineer\'s own judgment ("if you think you have been fine without it, retire it"), never through the tool judging them.',
  "Be terse. A per-practice health summary in a sentence or two, then one deep-dive on the practice that is not being honored. If a paragraph can be a sentence, make it a sentence.",
  "End the deep-dive with exactly one labeled recommendation drawn from: enforce it as a hard gate, revise its trigger so it fires, convert it to something invoked by hand, or retire it.",
].join("\n");

export interface SynthesizeAuditOptions {
  /** The judge/synthesis model port; required only when a deep-dive is warranted. */
  readonly llm?: JudgeModelPort;
}

export async function synthesizeAudit(
  report: LeverageAuditReport,
  _options: SynthesizeAuditOptions = {},
): Promise<AuditSynthesis> {
  const idle = report.levers.filter((lever) => lever.health === "idle");
  if (idle.length === 0) {
    return { narrative: deterministicSummary(report), modelConsulted: false };
  }
  const llm = _options.llm;
  if (llm === undefined) {
    throw new Error(
      "a leverage-audit deep-dive needs a synthesis model, but none was provided",
    );
  }
  const response = await llm.complete(buildAuditSynthesisPrompt(report));
  return { narrative: response.text, modelConsulted: true };
}

/**
 * Render the deterministic report as the user prompt: the full per-practice
 * health roster, the flagged idle practices to deep-dive, and the
 * convention-adherence distribution. These are the FACTS the model interprets; it
 * must not recompute them. The numbers are labeled here but the voice rules bar
 * them from the prose the model writes.
 */
function renderReport(
  report: LeverageAuditReport,
  idle: ReadonlyArray<LeverReport>,
): string {
  const lines: string[] = [
    "Leverage audit facts (interpret, do not recompute):",
  ];
  lines.push("", "Practices in force:");
  for (const lever of report.levers) {
    lines.push(
      `- ${lever.name}: ${lever.health}; fired in ${lever.firedSessions} of ${lever.eligibleSessions} conversations where it was in force; ${lever.inForceNow ? "still in your current setup" : "no longer in your current setup"}`,
    );
  }
  lines.push("", "Not being honored (deep-dive these):");
  for (const lever of idle) {
    lines.push(
      `- ${lever.name}: in force for ${lever.eligibleSessions} conversations, fired in none`,
    );
  }
  if (report.conventionAdherence.buckets.length > 0) {
    lines.push("", "Convention adherence across the window:");
    for (const bucket of report.conventionAdherence.buckets) {
      lines.push(`- ${bucket.value}: ${bucket.count}`);
    }
  }
  lines.push(
    "",
    "Write the health summary plus one deep-dive on the practice that is not being honored, ending in a labeled, we-framed recommendation among: enforce it as a hard gate, revise its trigger so it fires, convert it to something you invoke by hand, or retire it.",
  );
  return lines.join("\n");
}

/** The system and user text an audit deep-dive synthesis call sends the model. */
export interface AuditSynthesisPrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * The audit deep-dive synthesis prompt for one report. A pure function of
 * `report` only (the idle levers are derived deterministically from it): no
 * clock, no environment, no store or network access, so the same report
 * always yields byte-identical text. Exported so an eval harness can build the
 * exact prompt without also driving a {@link JudgeModelPort}.
 */
export function buildAuditSynthesisPrompt(
  report: LeverageAuditReport,
): AuditSynthesisPrompt {
  const idle = report.levers.filter((lever) => lever.health === "idle");
  return { system: AUDIT_SYNTHESIS_SYSTEM, user: renderReport(report, idle) };
}

/**
 * The deterministic health summary for a report with nothing wrong: a terse,
 * colleague-voiced line naming what is working and what is still too new to call,
 * with no model call. Never names an internal enum or a raw count in the prose.
 */
function deterministicSummary(report: LeverageAuditReport): string {
  if (report.levers.length === 0) {
    return "No established practices are in force yet, so there is nothing to audit for leverage.";
  }
  const working = report.levers
    .filter((lever) => lever.health === "working")
    .map((lever) => lever.name);
  const tooNew = report.levers
    .filter((lever) => lever.health === "too-new")
    .map((lever) => lever.name);

  const parts: string[] = [];
  if (working.length > 0) {
    parts.push(`${joinNames(working)} are pulling their weight`);
  }
  if (tooNew.length > 0) {
    parts.push(`${joinNames(tooNew)} too new to call yet`);
  }
  return `Everything you have set up is holding: ${parts.join(", ")}.`;
}

/** Join practice names into readable prose ("a", "a and b", "a, b, and c"). */
function joinNames(names: ReadonlyArray<string>): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
