/**
 * The judge calibration harness (calibrateSessions), end to end and hermetic.
 * A seeded store carries the baseline verdicts; a mocked candidate JudgeModelPort
 * stands in for the candidate judge, so the whole comparison is deterministic
 * with no network. The tests pin both modes (calibration agreement and health
 * elicitation checks), the read-only guarantee (no assessment run is written),
 * the version-mismatch refusal, candidate failures counted, structural-gate
 * detection, and the coarse golden expectations.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import { rolloutContent } from "../src/loader/rollout/codex-reader.ts";
import { assessConversation } from "../src/judged/assess.ts";
import { calibrateSessions } from "../src/judged/calibrate.ts";
import type { JudgeModelPort, JudgeModelResponse } from "../src/judged/port.ts";
import type { SetupSource } from "../src/judged/setup.ts";
import { writeAssessment } from "../src/judged/writer.ts";
import type { JudgeResult } from "../src/judged/types.ts";

const SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A small but real Codex rollout: meta, a human prompt, an assistant answer. */
const TRANSCRIPT = [
  line({
    timestamp: "2026-06-15T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: SESSION,
      cwd: "/work/p",
      originator: "codex_exec",
      source: "exec",
    },
  }),
  line({
    timestamp: "2026-06-15T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "add a test for the parser" }],
    },
  }),
  line({
    timestamp: "2026-06-15T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done, the parser test passes." }],
    },
  }),
].join("\n");

function seedRollout(sessionsDir: string, content = TRANSCRIPT): void {
  const dir = join(sessionsDir, "2026", "06", "15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-15T10-00-00-${SESSION}.jsonl`),
    content,
  );
}

interface Harness {
  store: Store;
  sessionsDir: string;
}

function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "regimen-calibrate-"));
  const store = openStore(":memory:");
  const sessionsDir = join(root, "sessions");
  return fn({ store, sessionsDir }).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

/** The chunk ids a verdict over {@link TRANSCRIPT} can cite. */
function transcriptIds(content: string): { human: number; answer: number } {
  const chunks = rolloutContent(content);
  const human = chunks.find((c) => c.kind === "human_prompt")!;
  const answer = chunks.find((c) => c.kind === "assistant_answer")!;
  return { human: human.lineSeq, answer: answer.lineSeq };
}

/** A verdict object citing valid ids, its signal values set by the caller. */
function verdict(
  content: string,
  values: {
    intent?: string;
    accomplishment?: string;
    correctionCost?: string;
    engagement?: string;
    attribution?: string;
    omitAssessment?: boolean;
  },
): string {
  const { human, answer } = transcriptIds(content);
  const v: Record<string, unknown> = {};
  if (values.intent !== undefined) {
    v.intent = { value: values.intent, anchors: [human] };
  }
  if (!values.omitAssessment) {
    v.assessment = {
      prose: "The engineer asked for a parser test; the agent delivered it.",
      anchors: [human, answer],
    };
  }
  if (values.accomplishment !== undefined) {
    v.accomplishment = { value: values.accomplishment, anchors: [answer] };
  }
  if (values.correctionCost !== undefined) {
    v["correction-cost"] = { value: values.correctionCost, anchors: [answer] };
  }
  if (values.engagement !== undefined) {
    v.engagement = { value: values.engagement, anchors: [answer] };
  }
  if (values.attribution !== undefined) {
    v.attribution = { value: values.attribution, anchors: [answer] };
  }
  return JSON.stringify(v);
}

/** A candidate port that returns a fixed verdict text. */
function candidatePort(
  text: string,
  model = "candidate-model",
): JudgeModelPort {
  return {
    complete(): Promise<JudgeModelResponse> {
      return Promise.resolve({ text, model });
    },
  };
}

/** Seed a baseline verdict at the current rubric version by running one assess pass. */
async function seedBaseline(
  h: Harness,
  values: Parameters<typeof verdict>[1],
): Promise<void> {
  await assessConversation({
    store: h.store,
    harness: "codex",
    sessionsDir: h.sessionsDir,
    sessionId: SESSION,
    llm: candidatePort(verdict(TRANSCRIPT, values)),
    runId: "baseline",
    now: () => new Date("2026-06-15T12:00:00.000Z"),
  });
}

test("calibration mode: a candidate that matches the baseline agrees on every signal", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    await seedBaseline(h, {
      intent: "test-writing",
      accomplishment: "accomplished",
    });

    const report = await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: [
        { harness: "codex", sessionsDir: h.sessionsDir, sessionId: SESSION },
      ],
      candidate: candidatePort(
        verdict(TRANSCRIPT, {
          intent: "test-writing",
          accomplishment: "accomplished",
        }),
      ),
    });

    expect(report.mode).toBe("calibration");
    const session = report.sessions[0]!;
    expect(session.status).toBe("compared");
    const disagreements = session.comparisons!.filter(
      (c) => c.agreement !== "agree",
    );
    expect(disagreements).toEqual([]);
    expect(report.pass).toBe(true);
  });
});

/** The single calibration target over the seeded reference session. */
function targets(h: Harness) {
  return [
    {
      harness: "codex" as const,
      sessionsDir: h.sessionsDir,
      sessionId: SESSION,
    },
  ];
}

function comparison(
  report: Awaited<ReturnType<typeof calibrateSessions>>,
  signalName: string,
) {
  return report.sessions[0]!.comparisons!.find(
    (c) => c.signalName === signalName,
  );
}

test("calibration mode: a differing label on a signal reads as a disagreement, and does not fail the run", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    await seedBaseline(h, {
      intent: "test-writing",
      accomplishment: "accomplished",
    });

    const report = await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: targets(h),
      candidate: candidatePort(
        verdict(TRANSCRIPT, {
          intent: "test-writing",
          accomplishment: "partial",
        }),
      ),
    });

    expect(comparison(report, "accomplishment")!.agreement).toBe("disagree");
    // Outcome derives from the axes, so it disagrees too (cleanly vs partial).
    expect(comparison(report, "outcome")!.agreement).toBe("disagree");
    // Disagreement is a judgment call surfaced, not an auto-failure.
    expect(report.pass).toBe(true);
  });
});

test("calibration mode: a signal the candidate omits reads as candidate-abstained", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    await seedBaseline(h, {
      intent: "test-writing",
      accomplishment: "accomplished",
    });

    const report = await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: targets(h),
      // No intent in the candidate verdict.
      candidate: candidatePort(
        verdict(TRANSCRIPT, { accomplishment: "accomplished" }),
      ),
    });

    expect(comparison(report, "intent")!.agreement).toBe("candidate-abstained");
  });
});

test("calibration mode: a signal only the candidate emits reads as baseline-abstained", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    // Baseline has no engagement.
    await seedBaseline(h, {
      intent: "test-writing",
      accomplishment: "accomplished",
    });

    const report = await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: targets(h),
      candidate: candidatePort(
        verdict(TRANSCRIPT, {
          intent: "test-writing",
          accomplishment: "accomplished",
          engagement: "engaged",
        }),
      ),
    });

    expect(comparison(report, "engagement")!.agreement).toBe(
      "baseline-abstained",
    );
  });
});

test("a candidate whose verdict does not parse is counted as a failure, not silently skipped", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    await seedBaseline(h, { accomplishment: "accomplished" });

    const report = await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: targets(h),
      candidate: candidatePort("this is not a verdict"),
    });

    expect(report.sessions[0]!.status).toBe("candidate-failed");
    expect(report.failures).toBe(1);
    expect(report.pass).toBe(false);
  });
});

/** Seed a baseline verdict at an explicit (possibly stale) rubric version. */
function seedBaselineAtVersion(h: Harness, rubricVersion: string): void {
  const { human, answer } = transcriptIds(TRANSCRIPT);
  const result: JudgeResult = {
    complete: true,
    provenance: {
      judgeModel: "baseline-model",
      rubricVersion,
      promptVersion: rubricVersion,
    },
    signals: [
      {
        scope: "assignment",
        assignmentId: "whole-conversation",
        signalName: "accomplishment",
        valueKind: "ordinal",
        value: "accomplished",
        anchors: [{ lineSeq: answer } as never],
      },
    ],
    narratives: [
      {
        scope: "conversation",
        narrativeType: "assessment",
        prose: "seeded",
        anchors: [{ lineSeq: human } as never],
      },
    ],
  };
  writeAssessment(
    h.store,
    {
      runId: "baseline",
      sessionId: SESSION,
      assignmentId: "whole-conversation",
      createdAt: "2026-06-15T12:00:00.000Z",
    },
    result,
  );
}

test("calibration mode refuses a baseline recorded under a different rubric version", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    seedBaselineAtVersion(h, "2026-01-01");

    const report = await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: targets(h),
      candidate: candidatePort(
        verdict(TRANSCRIPT, { accomplishment: "accomplished" }),
      ),
    });

    expect(report.sessions[0]!.status).toBe("version-mismatch");
    expect(report.versionMismatches).toBe(1);
    // A refusal is surfaced, not a hard failure of the calibration run.
    expect(report.pass).toBe(true);
  });
});

/** A setup source that always resolves a fixed setup (would trigger a snapshot write if honored). */
function stubSetupSource(): SetupSource {
  return {
    resolve() {
      return {
        conventions: [{ scope: "project", text: "a stub convention" }],
        practices: [{ name: "stub-practice", summary: "a stub practice" }],
      };
    },
  };
}

test("calibration is read-only: no assessment run and no setup snapshot are written", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    await seedBaseline(h, { accomplishment: "accomplished" });

    const runsBefore = (
      h.store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;

    await calibrateSessions({
      store: h.store,
      mode: "calibration",
      targets: targets(h),
      candidate: candidatePort(
        verdict(TRANSCRIPT, { accomplishment: "accomplished" }),
      ),
      // A setup source is injected; the read-only path must still write no snapshot.
      setupSource: stubSetupSource(),
    });

    const runsAfter = (
      h.store.db.prepare("SELECT COUNT(*) AS n FROM assessment_run").get() as {
        n: number;
      }
    ).n;
    expect(runsAfter).toBe(runsBefore);

    const snapshots = (
      h.store.db
        .prepare("SELECT COUNT(*) AS n FROM conversation_setup_snapshot")
        .get() as { n: number }
    ).n;
    expect(snapshots).toBe(0);
  });
});

test("health mode flags a structural-gate violation (attribution on a non-shortfall) and fails", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    // Health mode needs no baseline.
    const report = await calibrateSessions({
      store: h.store,
      mode: "health",
      targets: targets(h),
      candidate: candidatePort(
        verdict(TRANSCRIPT, {
          intent: "test-writing",
          accomplishment: "accomplished",
          engagement: "engaged",
          // attribution on an accomplished, non-shortfall verdict violates the gate.
          attribution: "ai",
        }),
      ),
    });

    const health = report.sessions[0]!.health!;
    expect(health.gateViolations).toContain("attribution-without-shortfall");
    expect(report.healthFindings).toBeGreaterThanOrEqual(1);
    expect(report.pass).toBe(false);
  });
});

test("health mode passes a well-formed candidate verdict with no findings", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    const report = await calibrateSessions({
      store: h.store,
      mode: "health",
      targets: targets(h),
      candidate: candidatePort(
        verdict(TRANSCRIPT, {
          intent: "test-writing",
          accomplishment: "accomplished",
          engagement: "engaged",
        }),
      ),
    });

    expect(report.sessions[0]!.health!.gateViolations).toEqual([]);
    expect(report.healthFindings).toBe(0);
    expect(report.pass).toBe(true);
  });
});

test("a violated golden expectation is a loud failure in both modes", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    await seedBaseline(h, { accomplishment: "accomplished" });

    const target = {
      harness: "codex" as const,
      sessionsDir: h.sessionsDir,
      sessionId: SESSION,
      expect: { outcome: "partial" },
    };
    const candidate = candidatePort(
      verdict(TRANSCRIPT, { accomplishment: "accomplished" }),
    );

    for (const mode of ["calibration", "health"] as const) {
      const report = await calibrateSessions({
        store: h.store,
        mode,
        targets: [target],
        candidate,
      });
      expect(report.expectationFailures).toBe(1);
      expect(report.sessions[0]!.expectationFailures![0]).toEqual({
        field: "outcome",
        expected: "partial",
        actual: "accomplished-cleanly",
      });
      expect(report.pass).toBe(false);
    }
  });
});

test("a met golden expectation does not fail the run", async () => {
  await withHarness(async (h) => {
    seedRollout(h.sessionsDir);
    const report = await calibrateSessions({
      store: h.store,
      mode: "health",
      targets: [
        {
          harness: "codex",
          sessionsDir: h.sessionsDir,
          sessionId: SESSION,
          expect: { outcome: "accomplished-cleanly", engagement: "engaged" },
        },
      ],
      candidate: candidatePort(
        verdict(TRANSCRIPT, {
          accomplishment: "accomplished",
          engagement: "engaged",
        }),
      ),
    });
    expect(report.expectationFailures).toBe(0);
    expect(report.pass).toBe(true);
  });
});
