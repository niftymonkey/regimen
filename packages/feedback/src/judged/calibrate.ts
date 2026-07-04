/**
 * The judge calibration harness: a READ-ONLY comparison of a candidate judge
 * configuration against the reference sessions in the store. It reuses the
 * emit-prompt preparation path (prepareConversation + buildJudgePrompt) to get
 * the exact versioned prompt for each session, calls the candidate backend
 * directly, runs the response through the SAME shared verdict pipeline
 * (verdict.ts: closed vocabulary, anchor membership, structural gates), and
 * compares in memory. It never calls writeAssessment, never supersedes a run,
 * and passes persistSetupSnapshot:false so no snapshot row is written; the only
 * store touch is the idempotent anchor-event insert the read path already does.
 *
 * Two modes. CALIBRATION scores per-signal agreement of the candidate against
 * the stored baseline at the SAME rubric version (refusing a baseline on a
 * different rubric version, since labels legitimately differ across rubrics).
 * HEALTH is a rubric-regression check that ignores baselines: it scores
 * elicitation health of the candidate itself (parse, closed vocabulary, anchor
 * resolution, structural gates, abstention rates). Coarse golden expectations
 * are checked in BOTH modes and are loud failures. Each mode emits a single
 * overall PASS/FAIL suitable for gating.
 */
import type { Harness } from "@regimen/shared";
import { harnessSupport } from "../harness/support.ts";
import type { Store } from "../store.ts";
import { readJudgmentDigest } from "./digest.ts";
import { deriveOutcome } from "./outcome.ts";
import type { JudgeModelPort } from "./port.ts";
import { buildJudgePrompt } from "./prompt.ts";
import { prepareConversation } from "./read-conversation.ts";
import type { SetupSource } from "./setup.ts";
import type {
  AccomplishmentValue,
  CorrectionCostValue,
  SignalName,
} from "./types.ts";
import {
  assembleVerdict,
  diagnoseVerdict,
  type GateViolation,
  type SignalDiagnostic,
} from "./verdict.ts";
import { RUBRIC_VERSION } from "./versions.ts";

export type CalibrationMode = "calibration" | "health";

/** How a candidate signal value relates to the baseline value for that signal. */
export type Agreement =
  | "agree"
  | "disagree"
  | "candidate-abstained"
  | "baseline-abstained";

/** One signal's baseline-vs-candidate comparison (calibration mode). */
export interface SignalComparison {
  readonly signalName: SignalName;
  readonly baseline: string | null;
  readonly candidate: string | null;
  readonly agreement: Agreement;
}

/** A coarse golden invariant that the candidate verdict violated. */
export interface ExpectationFailure {
  readonly field: "outcome" | "engagement";
  readonly expected: string;
  readonly actual: string | null;
}

/** The candidate's elicitation health for one session (health mode). */
export interface SessionHealth {
  readonly signals: ReadonlyArray<SignalDiagnostic>;
  readonly gateViolations: ReadonlyArray<GateViolation>;
  /** The always-on signals the candidate did not emit. */
  readonly abstentions: ReadonlyArray<SignalName>;
}

export type SessionCalibrationStatus =
  | "compared"
  | "candidate-failed"
  | "version-mismatch"
  | "baseline-unjudged"
  | "unresolved";

/** One reference session's calibration result. */
export interface SessionCalibration {
  readonly sessionId: string;
  readonly status: SessionCalibrationStatus;
  readonly reason?: string;
  readonly candidateModel?: string;
  readonly comparisons?: ReadonlyArray<SignalComparison>;
  readonly health?: SessionHealth;
  readonly expectationFailures?: ReadonlyArray<ExpectationFailure>;
}

/** Per-signal agreement tallies across the compared sessions (calibration mode). */
export interface SignalAgreement {
  readonly signalName: SignalName;
  readonly agree: number;
  readonly disagree: number;
  readonly candidateAbstained: number;
  readonly baselineAbstained: number;
}

/** Per-signal abstention tally across the compared sessions (health mode). */
export interface SignalAbstention {
  readonly signalName: SignalName;
  readonly emitted: number;
  readonly abstained: number;
}

export interface CalibrationReport {
  readonly mode: CalibrationMode;
  readonly candidateModels: ReadonlyArray<string>;
  readonly sessions: ReadonlyArray<SessionCalibration>;
  readonly perSignalAgreement?: ReadonlyArray<SignalAgreement>;
  readonly perSignalAbstention?: ReadonlyArray<SignalAbstention>;
  /** Candidate parse/transport failures plus sessions whose transcript could not be prepared. */
  readonly failures: number;
  /** Calibration-mode refusals: a stored baseline on a different rubric version. */
  readonly versionMismatches: number;
  /** Calibration-mode refusals: a session with no stored baseline verdict. */
  readonly baselineUnjudged: number;
  /** Health-mode total structural-gate, out-of-vocabulary, and unresolved-anchor findings. */
  readonly healthFindings: number;
  readonly expectationFailures: number;
  /** The single overall gate: false on any hard finding for the mode. */
  readonly pass: boolean;
}

/** A coarse golden invariant, checked in both modes. */
export interface Expectation {
  readonly outcome?: string;
  readonly engagement?: string;
}

/** One reference session to calibrate: its harness, transcript root, id, and optional invariants. */
export interface CalibrateTarget {
  readonly harness: Harness;
  readonly sessionsDir: string;
  readonly sessionId: string;
  readonly expect?: Expectation;
}

export interface CalibrateSessionsOptions {
  readonly store: Store;
  readonly mode: CalibrationMode;
  readonly targets: ReadonlyArray<CalibrateTarget>;
  readonly candidate: JudgeModelPort;
  readonly setupSource?: SetupSource;
  readonly now?: () => Date;
}

/** The always-on signals whose absence is an abstention worth tracking in health mode. */
const ALWAYS_ON_SIGNALS: ReadonlyArray<SignalName> = [
  "intent",
  "accomplishment",
  "engagement",
  "framing",
  "conducting",
  "verification",
  "effort",
];

/** The candidate's signal values, keyed by signal name, plus the derived Outcome. */
function candidateValueMap(
  signals: ReadonlyArray<{ signalName: SignalName; value: string }>,
): Map<SignalName, string> {
  const map = new Map<SignalName, string>();
  for (const signal of signals) map.set(signal.signalName, signal.value);
  const accomplishment = map.get("accomplishment");
  if (accomplishment !== undefined) {
    map.set(
      "outcome",
      deriveOutcome(
        accomplishment as AccomplishmentValue,
        map.get("correction-cost") as CorrectionCostValue | undefined,
      ),
    );
  }
  return map;
}

/** Classify one signal's candidate value against the baseline value. */
function classify(
  baseline: string | undefined,
  candidate: string | undefined,
): Agreement {
  if (baseline !== undefined && candidate !== undefined) {
    return baseline === candidate ? "agree" : "disagree";
  }
  return baseline !== undefined ? "candidate-abstained" : "baseline-abstained";
}

/** The per-signal comparison over the union of baseline and candidate signals. */
function compareSignals(
  baseline: ReadonlyMap<SignalName, string>,
  candidate: ReadonlyMap<SignalName, string>,
): SignalComparison[] {
  const names = new Set<SignalName>([...baseline.keys(), ...candidate.keys()]);
  return [...names].sort().map((signalName) => {
    const b = baseline.get(signalName);
    const c = candidate.get(signalName);
    return {
      signalName,
      baseline: b ?? null,
      candidate: c ?? null,
      agreement: classify(b, c),
    };
  });
}

/** The coarse golden invariants the candidate verdict failed, if any. */
function checkExpectations(
  expect: Expectation | undefined,
  values: ReadonlyMap<SignalName, string>,
): ExpectationFailure[] {
  if (expect === undefined) return [];
  const failures: ExpectationFailure[] = [];
  for (const field of ["outcome", "engagement"] as const) {
    const expected = expect[field];
    if (expected === undefined) continue;
    const actual = values.get(field) ?? null;
    if (actual !== expected) failures.push({ field, expected, actual });
  }
  return failures;
}

/** Calibrate one reference session, read-only. */
async function calibrateOne(
  options: CalibrateSessionsOptions,
  target: CalibrateTarget,
  now: () => Date,
): Promise<SessionCalibration> {
  const { store, mode, candidate } = options;
  const { sessionId } = target;

  let prepared;
  try {
    const support = harnessSupport(target.harness);
    if (support === undefined) {
      throw new Error(`unsupported harness: ${target.harness}`);
    }
    prepared = prepareConversation({
      support,
      sessionsDir: target.sessionsDir,
      sessionId,
      store,
      ...(options.setupSource === undefined
        ? {}
        : { setupSource: options.setupSource }),
      now,
      persistSetupSnapshot: false,
    });
  } catch (err) {
    return { sessionId, status: "unresolved", reason: (err as Error).message };
  }
  if (prepared.content.length === 0) {
    return {
      sessionId,
      status: "unresolved",
      reason: "no content chunks to judge",
    };
  }

  const prompt = buildJudgePrompt(prepared.content, prepared.setup);
  let response;
  try {
    response = await candidate.complete({
      system: prompt.system,
      user: prompt.user,
    });
  } catch (err) {
    return {
      sessionId,
      status: "candidate-failed",
      reason: `candidate model call failed: ${(err as Error).message}`,
    };
  }
  const candidateModel = response.model;

  const assembled = assembleVerdict(response.text, prepared.content);
  if (!assembled.ok) {
    return {
      sessionId,
      status: "candidate-failed",
      reason: assembled.reason,
      candidateModel,
    };
  }
  const values = candidateValueMap(
    assembled.signals.map((s) => ({
      signalName: s.signalName,
      value: String(s.value),
    })),
  );
  const expectationFailures = checkExpectations(target.expect, values);
  const expect = expectationFailures.length > 0 ? { expectationFailures } : {};

  if (mode === "health") {
    const diag = diagnoseVerdict(response.text, prepared.content);
    const abstentions = ALWAYS_ON_SIGNALS.filter((name) => !values.has(name));
    return {
      sessionId,
      status: "compared",
      candidateModel,
      health: {
        signals: diag.signals,
        gateViolations: diag.gateViolations,
        abstentions,
      },
      ...expect,
    };
  }

  const baseline = readJudgmentDigest(store.db, sessionId, () =>
    now().getTime(),
  );
  if (!baseline.judged) {
    return {
      sessionId,
      status: "baseline-unjudged",
      reason: "no stored baseline verdict for this session",
      candidateModel,
      ...expect,
    };
  }
  if (baseline.provenance.rubricVersion !== RUBRIC_VERSION) {
    return {
      sessionId,
      status: "version-mismatch",
      reason: `baseline rubric ${baseline.provenance.rubricVersion} is not the current ${RUBRIC_VERSION}`,
      candidateModel,
      ...expect,
    };
  }
  const baselineValues = new Map<SignalName, string>(
    baseline.assignment.signals.map((s) => [s.signalName, s.value]),
  );
  return {
    sessionId,
    status: "compared",
    candidateModel,
    comparisons: compareSignals(baselineValues, values),
    ...expect,
  };
}

/** Per-signal agreement tallies across the compared calibration sessions. */
function agreementSummary(
  sessions: ReadonlyArray<SessionCalibration>,
): SignalAgreement[] {
  const by = new Map<SignalName, SignalAgreement>();
  const bump = (name: SignalName, agreement: Agreement): void => {
    const row = by.get(name) ?? {
      signalName: name,
      agree: 0,
      disagree: 0,
      candidateAbstained: 0,
      baselineAbstained: 0,
    };
    const next = {
      ...row,
      agree: row.agree + (agreement === "agree" ? 1 : 0),
      disagree: row.disagree + (agreement === "disagree" ? 1 : 0),
      candidateAbstained:
        row.candidateAbstained + (agreement === "candidate-abstained" ? 1 : 0),
      baselineAbstained:
        row.baselineAbstained + (agreement === "baseline-abstained" ? 1 : 0),
    };
    by.set(name, next);
  };
  for (const session of sessions) {
    for (const c of session.comparisons ?? []) bump(c.signalName, c.agreement);
  }
  return [...by.values()].sort((a, b) =>
    a.signalName < b.signalName ? -1 : 1,
  );
}

/** Per-signal abstention tallies across the compared health sessions. */
function abstentionSummary(
  sessions: ReadonlyArray<SessionCalibration>,
): SignalAbstention[] {
  const compared = sessions.filter((s) => s.health !== undefined);
  return ALWAYS_ON_SIGNALS.map((signalName) => {
    const abstained = compared.filter((s) =>
      s.health!.abstentions.includes(signalName),
    ).length;
    return {
      signalName,
      emitted: compared.length - abstained,
      abstained,
    };
  });
}

/** The count of health findings (gate, vocabulary, and anchor) over compared sessions. */
function countHealthFindings(
  sessions: ReadonlyArray<SessionCalibration>,
): number {
  let total = 0;
  for (const session of sessions) {
    const health = session.health;
    if (health === undefined) continue;
    total += health.gateViolations.length;
    for (const signal of health.signals) {
      if (!signal.inVocabulary) total += 1;
      if (!signal.anchorsResolved) total += 1;
    }
  }
  return total;
}

export async function calibrateSessions(
  options: CalibrateSessionsOptions,
): Promise<CalibrationReport> {
  const now = options.now ?? (() => new Date());
  const sessions: SessionCalibration[] = [];
  for (const target of options.targets) {
    sessions.push(await calibrateOne(options, target, now));
  }

  const models = new Set<string>();
  for (const session of sessions) {
    if (session.candidateModel !== undefined)
      models.add(session.candidateModel);
  }

  const failures = sessions.filter(
    (s) => s.status === "candidate-failed" || s.status === "unresolved",
  ).length;
  const versionMismatches = sessions.filter(
    (s) => s.status === "version-mismatch",
  ).length;
  const baselineUnjudged = sessions.filter(
    (s) => s.status === "baseline-unjudged",
  ).length;
  const expectationFailures = sessions.reduce(
    (sum, s) => sum + (s.expectationFailures?.length ?? 0),
    0,
  );
  const healthFindings =
    options.mode === "health" ? countHealthFindings(sessions) : 0;

  const pass =
    options.mode === "health"
      ? failures === 0 && healthFindings === 0 && expectationFailures === 0
      : failures === 0 && expectationFailures === 0;

  return {
    mode: options.mode,
    candidateModels: [...models].sort(),
    sessions,
    ...(options.mode === "calibration"
      ? { perSignalAgreement: agreementSummary(sessions) }
      : { perSignalAbstention: abstentionSummary(sessions) }),
    failures,
    versionMismatches,
    baselineUnjudged,
    healthFindings,
    expectationFailures,
    pass,
  };
}

/** Right-pad a cell to a column width for the terse diagnostic table. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The short session id the table prints (the 8 characters `list` shows). */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Render a calibration report as a terse diagnostic table plus a single overall
 * PASS/FAIL line for gating. This is a data surface, not a prose answer, so the
 * table is allowed the internal signal vocabulary the voice guide keeps out of
 * synthesized prose.
 */
export function formatCalibration(report: CalibrationReport): string {
  const lines: string[] = [];
  const models =
    report.candidateModels.length > 0
      ? report.candidateModels.join(", ")
      : "none";
  const title =
    report.mode === "health" ? "judge health check" : "judge calibration";
  lines.push(
    `${title} (candidate: ${models}) over ${report.sessions.length} session(s)`,
    "",
  );

  lines.push(`${pad("session", 10)}${pad("status", 18)}detail`);
  for (const session of report.sessions) {
    const detail = sessionDetail(session);
    lines.push(
      `${pad(shortId(session.sessionId), 10)}${pad(session.status, 18)}${detail}`,
    );
  }
  lines.push("");

  if (report.mode === "calibration" && report.perSignalAgreement) {
    lines.push("per-signal agreement (baseline vs candidate):");
    lines.push(
      `  ${pad("signal", 22)}${pad("agree", 8)}${pad("disagree", 10)}${pad("cand-abstain", 14)}base-abstain`,
    );
    for (const row of report.perSignalAgreement) {
      lines.push(
        `  ${pad(row.signalName, 22)}${pad(String(row.agree), 8)}${pad(String(row.disagree), 10)}${pad(String(row.candidateAbstained), 14)}${row.baselineAbstained}`,
      );
    }
    lines.push("");
  }

  if (report.mode === "health" && report.perSignalAbstention) {
    lines.push("per-signal abstention (candidate):");
    lines.push(`  ${pad("signal", 22)}${pad("emitted", 10)}abstained`);
    for (const row of report.perSignalAbstention) {
      lines.push(
        `  ${pad(row.signalName, 22)}${pad(String(row.emitted), 10)}${row.abstained}`,
      );
    }
    lines.push("");
  }

  const tallies =
    report.mode === "health"
      ? `${report.failures} failure(s), ${report.healthFindings} health finding(s), ${report.expectationFailures} expectation failure(s)`
      : `${report.failures} failure(s), ${report.versionMismatches} rubric-version refusal(s), ${report.baselineUnjudged} unjudged refusal(s), ${report.expectationFailures} expectation failure(s)`;
  lines.push(tallies);
  lines.push(report.pass ? "PASS" : "FAIL");
  return `${lines.join("\n")}\n`;
}

/** The per-session detail cell: comparison summary, health findings, or the refusal reason. */
function sessionDetail(session: SessionCalibration): string {
  const parts: string[] = [];
  if (session.status !== "compared" && session.reason !== undefined) {
    parts.push(session.reason);
  }
  if (session.comparisons !== undefined) {
    const disagree = session.comparisons.filter(
      (c) => c.agreement === "disagree",
    ).length;
    parts.push(`${disagree} disagreement(s)`);
  }
  if (session.health !== undefined) {
    const vocab = session.health.signals.filter((s) => !s.inVocabulary).length;
    const anchors = session.health.signals.filter(
      (s) => !s.anchorsResolved,
    ).length;
    parts.push(
      `${session.health.gateViolations.length} gate, ${vocab} out-of-vocab, ${anchors} unresolved-anchor`,
    );
  }
  for (const failure of session.expectationFailures ?? []) {
    parts.push(
      `expected ${failure.field} ${failure.expected}, got ${failure.actual ?? "none"}`,
    );
  }
  return parts.join("; ");
}
