/**
 * The assess orchestrator: assessConversation (S3, spec section 1).
 *
 * The composition root for one `feedback assess` pass over one conversation. It
 * locates the session's rollout file, reads it once with the S2 reader, inserts
 * the reader's structural events into the store (the load-bearing anchor step,
 * section 4) so {eventHash} anchors resolve, hands the content chunks to the
 * Judge, writes the verdict superseding any prior run, and returns the
 * JudgmentDigest. Every heavy piece (reader, store, judge) is a deep module it
 * composes; its own complexity is the sequencing and the fail-closed branching.
 *
 * Fail-closed (section 5): a missing transcript throws a clear error and writes
 * nothing; insufficient evidence and unparseable output are honest incomplete
 * runs the Judge already shaped, written as-is.
 */
import type { Harness } from "@regimen/shared";
import type { Store } from "../store.ts";
import { harnessSupport } from "../harness/support.ts";
import { readJudgmentDigest, type JudgmentDigest } from "./digest.ts";
import { judgeConversation } from "./judge.ts";
import type { JudgeModelPort } from "./port.ts";
import { prepareConversation } from "./read-conversation.ts";
import type { SetupSource } from "./setup.ts";
import type { JudgeBackend, JudgeResult } from "./types.ts";
import { PROMPT_VERSION, RUBRIC_VERSION } from "./versions.ts";
import { writeAssessment } from "./writer.ts";

const WHOLE_CONVERSATION_ASSIGNMENT = "whole-conversation";

export interface AssessOptions {
  readonly store: Store;
  /** The harness whose support bundle (resolver + reader) assess uses. */
  readonly harness: Harness;
  /** The harness sessions root, e.g. <harnessHome>/sessions. */
  readonly sessionsDir: string;
  readonly sessionId: string;
  /** The injected Judge model port; tests pass a deterministic stub. */
  readonly llm: JudgeModelPort;
  /**
   * The injected source of the engineer's setup (the expected behaviors the
   * judge weighs). Optional and additive: with no source injected, no setup is
   * resolved and the judge stays setup-blind, byte-identical to before. The CLI
   * binds the live adapter; tests inject a stub.
   */
  readonly setupSource?: SetupSource;
  /**
   * The backend tag the resolver built for `llm`, threaded onto provenance so
   * the stored run records which backend judged (judge-backends decision 4).
   * Never self-reported: the CLI passes the resolver's tag. Absent on the
   * pre-backends default.
   */
  readonly judgeBackend?: JudgeBackend;
  /** The run id to mint; omit for a generated one. */
  readonly runId?: string;
  /** Injectable clock for deterministic created_at and generatedAt. */
  readonly now?: () => Date;
}

/**
 * Run one assess pass and return the resulting JudgmentDigest. Throws when the
 * transcript is missing (the only fail-closed case that errors); the other
 * degraded cases are written as honest incomplete runs.
 */
export async function assessConversation(
  options: AssessOptions,
): Promise<JudgmentDigest> {
  const { store, harness, sessionsDir, sessionId, llm } = options;
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? crypto.randomUUID();

  // The single harness seam: one registry lookup binds the resolver and reader
  // for this harness. Fail closed (section 5) on an unregistered harness, before
  // any store write, so an unsupported harness never produces a partial run.
  const support = harnessSupport(harness);
  if (support === undefined) {
    throw new Error(`unsupported harness: ${harness}`);
  }

  // The shared front-half (locate, read, quarantine, insert the anchor events,
  // resolve the setup as of the conversation): identical to the tier C seam so
  // an anchor resolves the same way whether the in-process judge or the agent
  // recorder produced the verdict. Throws on a missing transcript, before any
  // verdict write. Insufficient evidence (section 5.2): a transcript that yields
  // zero content chunks gives the judge nothing to ground a signal on, so the
  // run is an honest incomplete one with no fabricated signal and no judge call.
  const prepared = prepareConversation({
    support,
    sessionsDir,
    sessionId,
    store,
    ...(options.setupSource === undefined
      ? {}
      : { setupSource: options.setupSource }),
    now,
  });

  const result: JudgeResult =
    prepared.content.length === 0
      ? {
          complete: false,
          provenance: {
            judgeModel: "none",
            rubricVersion: RUBRIC_VERSION,
            promptVersion: PROMPT_VERSION,
            ...(options.judgeBackend === undefined
              ? {}
              : { judgeBackend: options.judgeBackend }),
          },
          signals: [],
          narratives: [],
          incompleteReason: "insufficient-evidence",
        }
      : await judgeConversation(
          { sessionId, chunks: prepared.content },
          {
            llm,
            now,
            ...(prepared.setup === undefined ? {} : { setup: prepared.setup }),
            ...(options.judgeBackend === undefined
              ? {}
              : { judgeBackend: options.judgeBackend }),
          },
        );

  writeAssessment(
    store,
    {
      runId,
      sessionId,
      assignmentId: WHOLE_CONVERSATION_ASSIGNMENT,
      createdAt: now().toISOString(),
    },
    result,
  );

  return readJudgmentDigest(store.db, sessionId, () => now().getTime());
}
