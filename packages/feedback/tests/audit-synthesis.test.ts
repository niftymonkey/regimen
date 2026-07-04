/**
 * The leverage-audit synthesis layer, observed through synthesizeAudit.
 *
 * The synthesis interprets the deterministic report into prose and consults the
 * model ONLY when a practice is idle (something is wrong). All-healthy and empty
 * reports are summarized deterministically with no paid call. The model port is a
 * capturing stub: the tests assert both whether it was called and, when it was,
 * that the composed system prompt carries the binding voice constraints
 * (docs/regimen-voice-and-ux.md). No network, no store.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  JudgeModelPort,
  JudgeModelRequest,
  JudgeModelResponse,
} from "../src/judged/port.ts";
import type { LeverReport, LeverageAuditReport } from "../src/judged/audit.ts";
import {
  AUDIT_SYNTHESIS_SYSTEM,
  buildAuditSynthesisPrompt,
  synthesizeAudit,
} from "../src/judged/audit-synthesis.ts";

/** A model port that records every request and returns a fixed narrative. */
function capturingLlm(text = "the deep-dive narrative"): {
  port: JudgeModelPort;
  requests: JudgeModelRequest[];
} {
  const requests: JudgeModelRequest[] = [];
  const port: JudgeModelPort = {
    complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
      requests.push(request);
      return Promise.resolve({ text, model: "test-model" });
    },
  };
  return { port, requests };
}

function lever(over: Partial<LeverReport> & { name: string }): LeverReport {
  return {
    eligibleSessions: 5,
    firedSessions: 3,
    health: "working",
    inForceNow: true,
    ...over,
  };
}

function report(
  levers: ReadonlyArray<LeverReport>,
  buckets: LeverageAuditReport["conventionAdherence"]["buckets"] = [],
): LeverageAuditReport {
  return { levers, conventionAdherence: { buckets } };
}

test("an all-healthy report is summarized without any model call", async () => {
  const { port, requests } = capturingLlm();
  const result = await synthesizeAudit(
    report([lever({ name: "tdd" }), lever({ name: "brainstorming" })]),
    { llm: port },
  );
  expect(requests).toHaveLength(0);
  expect(result.modelConsulted).toBe(false);
  expect(result.narrative.length).toBeGreaterThan(0);
});

test("an empty report says there is nothing to audit, with no model call", async () => {
  const { port, requests } = capturingLlm();
  const result = await synthesizeAudit(report([]), { llm: port });
  expect(requests).toHaveLength(0);
  expect(result.modelConsulted).toBe(false);
  expect(result.narrative.length).toBeGreaterThan(0);
});

test("an idle practice drives the on-demand model deep-dive", async () => {
  const { port, requests } = capturingLlm(
    "your work-router habit has gone quiet",
  );
  const result = await synthesizeAudit(
    report([
      lever({ name: "tdd" }),
      lever({
        name: "work-router",
        health: "idle",
        eligibleSessions: 9,
        firedSessions: 0,
      }),
    ]),
    { llm: port },
  );
  expect(requests).toHaveLength(1);
  expect(result.modelConsulted).toBe(true);
  expect(result.narrative).toBe("your work-router habit has gone quiet");
  // The deterministic facts reach the model in the user prompt: the idle
  // practice's name and its counts, so the model interprets rather than tallies.
  expect(requests[0]?.user).toContain("work-router");
});

test("buildAuditSynthesisPrompt is pure: the same report yields byte-identical text across calls", () => {
  const idleReport = report([
    lever({ name: "work-router", health: "idle", firedSessions: 0 }),
  ]);

  const first = buildAuditSynthesisPrompt(idleReport);
  const second = buildAuditSynthesisPrompt(idleReport);

  expect(second).toEqual(first);
});

test("buildAuditSynthesisPrompt is a stable hash of a fixed report, with no clock or environment leaking in", () => {
  const idleReport = report(
    [
      lever({ name: "tdd" }),
      lever({
        name: "work-router",
        health: "idle",
        eligibleSessions: 9,
        firedSessions: 0,
      }),
    ],
    [{ value: "followed", count: 4 }],
  );

  const prompt = buildAuditSynthesisPrompt(idleReport);
  const systemHash = createHash("sha256").update(prompt.system).digest("hex");
  const userHash = createHash("sha256").update(prompt.user).digest("hex");

  expect(systemHash).toBe(
    "1b6682a700b0f4b9248003b6872def87800134c57b032dab41ecc334f80d2bf3",
  );
  expect(userHash).toBe(
    "cf34ca3bfd883898195c1a1fd8172989244f9f5c8d9dcfc151a69185166dc14b",
  );
});

test("the deep-dive system prompt carries the binding voice constraints", async () => {
  const { port, requests } = capturingLlm();
  await synthesizeAudit(
    report([lever({ name: "work-router", health: "idle", firedSessions: 0 })]),
    { llm: port },
  );
  const system = requests[0]?.system ?? "";
  expect(system).toBe(AUDIT_SYNTHESIS_SYSTEM);
  // The load-bearing voice rules from docs/regimen-voice-and-ux.md.
  expect(system).toContain("colleague");
  expect(system).toContain("no signal names");
  // Shortfalls take a neutral subject; only wins get "you".
  expect(system.toLowerCase()).toContain("neutral subject");
  // Recommendations are we-framed and announce themselves.
  expect(system).toContain("My recommendation is that we");
  // The four remedy labels the audit may recommend.
  for (const remedy of ["enforce", "revise", "convert", "retire"]) {
    expect(system).toContain(remedy);
  }
});
