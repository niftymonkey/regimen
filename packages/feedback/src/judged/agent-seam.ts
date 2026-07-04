/**
 * The tier C agent-driven judging seam (judge-backends design decision 3): two
 * deterministic orchestrations that let the conversation's own agent produce the
 * judgment when there is no separate inference key. It is deliberately NOT a
 * JudgeModelPort adapter: the round trip spans two process invocations (emit,
 * then the agent's turn, then record), so the seam is the CLI surface itself.
 *
 * `emitPrompt` performs the same front half as the assess spine (locate, read,
 * insert the anchor events, resolve the setup) and prints the exact versioned
 * judge prompt, writing no run. `recordVerdict` re-reads the transcript,
 * re-validates the agent's verdict through the SAME shared verdict pipeline the
 * in-process judge uses (parse, closed vocabulary, anchor membership), and
 * persists it through the same writer, stamped judge_backend=agent with the
 * self-reported model as opaque provenance. Both compose the shared pieces the
 * assess spine composes; the version-mismatch guard makes a stale emitted prompt
 * unrecordable under a rubric it was not elicited by.
 */
import type { Harness } from "@regimen/shared";
import type { Store } from "../store.ts";
import { harnessSupport } from "../harness/support.ts";
import { readJudgmentDigest, type JudgmentDigest } from "./digest.ts";
import { buildJudgePrompt } from "./prompt.ts";
import { prepareConversation } from "./read-conversation.ts";
import type { SetupSource } from "./setup.ts";
import type { JudgeResult } from "./types.ts";
import { assembleVerdict } from "./verdict.ts";
import { PROMPT_VERSION, RUBRIC_VERSION } from "./versions.ts";
import { writeAssessment } from "./writer.ts";

const SCHEMA_VERSION = 1;
const WHOLE_CONVERSATION_ASSIGNMENT = "whole-conversation";

export interface EmitPromptOptions {
  readonly store: Store;
  readonly harness: Harness;
  readonly sessionsDir: string;
  readonly sessionId: string;
  readonly setupSource?: SetupSource;
  readonly now?: () => Date;
}

/**
 * The emitted prompt envelope: the exact system rubric and rendered conversation
 * projection with citable ids, version-pinned so the recorder can bind them.
 * Deterministic: same transcript in, same envelope out (modulo appended growth).
 */
export interface PromptEnvelope {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly harness: Harness;
  readonly promptVersion: string;
  readonly rubricVersion: string;
  readonly system: string;
  readonly user: string;
}

/**
 * Emit the versioned judge prompt for one conversation. Throws on an
 * unsupported harness or a missing transcript (the fail-closed cases assess
 * errors on); writes no assessment run, makes no LLM call.
 */
export function emitPrompt(options: EmitPromptOptions): PromptEnvelope {
  const { store, harness, sessionsDir, sessionId } = options;
  const now = options.now ?? (() => new Date());
  const support = harnessSupport(harness);
  if (support === undefined) {
    throw new Error(`unsupported harness: ${harness}`);
  }
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
  const prompt = buildJudgePrompt(prepared.content, prepared.setup);
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    harness,
    promptVersion: PROMPT_VERSION,
    rubricVersion: RUBRIC_VERSION,
    system: prompt.system,
    user: prompt.user,
  };
}

/** The record envelope the calling agent pipes back: the versions it was handed plus its verdict. */
export interface RecordEnvelope {
  readonly schemaVersion?: number;
  readonly sessionId?: string;
  readonly promptVersion?: string;
  readonly rubricVersion?: string;
  /** The agent's self-reported model id, stored opaque (ADR-0008). */
  readonly judgeModel?: string;
  /** The verdict JSON object the emitted prompt elicited. */
  readonly verdict?: unknown;
}

export interface RecordVerdictOptions {
  readonly store: Store;
  readonly harness: Harness;
  readonly sessionsDir: string;
  readonly sessionId: string;
  readonly envelope: RecordEnvelope;
  readonly now?: () => Date;
  readonly runId?: string;
}

/**
 * The outcome of a record attempt: the digest on acceptance, or a typed
 * rejection reason on a malformed, stale, mismatched, or unanchorable verdict.
 * A rejection writes NOTHING (design decision 4), keeping the session honestly
 * unjudged and re-sweepable rather than flipping it to judged on a formatting
 * slip.
 */
export type RecordVerdictResult =
  | { readonly ok: true; readonly digest: JudgmentDigest }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate one agent verdict against the conversation and persist it. Rejects,
 * writing nothing, on a version mismatch (the emitted prompt is stale), a
 * session mismatch, a malformed or out-of-vocabulary verdict, or a verdict whose
 * every claim fails anchor membership. On acceptance it writes through the same
 * writer as the in-process judge, stamped judge_backend=agent, and returns the
 * resulting digest.
 */
export function recordVerdict(
  options: RecordVerdictOptions,
): RecordVerdictResult {
  const { store, harness, sessionsDir, sessionId, envelope } = options;
  const now = options.now ?? (() => new Date());

  // The version-mismatch guard (design decision 4): a stale emitted prompt, or a
  // `regimen update` between emit and record, can never be recorded under a
  // rubric it was not elicited by. Cheap checks first, before any I/O, so a
  // rejection writes nothing at all.
  if (
    envelope.promptVersion !== PROMPT_VERSION ||
    envelope.rubricVersion !== RUBRIC_VERSION
  ) {
    return {
      ok: false,
      reason: "the judge prompt has changed; re-run --emit-prompt",
    };
  }
  if (envelope.sessionId !== undefined && envelope.sessionId !== sessionId) {
    return {
      ok: false,
      reason: `session mismatch: the verdict names session ${envelope.sessionId} but this is ${sessionId}`,
    };
  }

  const support = harnessSupport(harness);
  if (support === undefined) {
    throw new Error(`unsupported harness: ${harness}`);
  }
  // Re-read the transcript and re-insert the anchor events (idempotent); the
  // recorder resolves no setup, since it validates an already-produced verdict.
  const prepared = prepareConversation({
    support,
    sessionsDir,
    sessionId,
    store,
    now,
  });

  // The SAME gate every in-process verdict passes, applied at the intake: an
  // agent cannot record a value outside the closed vocabularies, an Outcome
  // without preceding assessment prose, or an anchor citing a nonexistent chunk.
  const raw = JSON.stringify(envelope.verdict ?? null);
  const outcome = assembleVerdict(raw, prepared.content);
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  if (outcome.signals.length === 0) {
    return {
      ok: false,
      reason:
        "no signal in the verdict anchored to the conversation; re-cite chunk ids that exist in the projection",
    };
  }

  const result: JudgeResult = {
    complete: true,
    provenance: {
      judgeModel:
        envelope.judgeModel !== undefined && envelope.judgeModel.length > 0
          ? envelope.judgeModel
          : "agent",
      rubricVersion: RUBRIC_VERSION,
      promptVersion: PROMPT_VERSION,
      judgeBackend: "agent",
    },
    signals: outcome.signals,
    narratives: outcome.narratives,
  };

  writeAssessment(
    store,
    {
      runId: options.runId ?? crypto.randomUUID(),
      sessionId,
      assignmentId: WHOLE_CONVERSATION_ASSIGNMENT,
      createdAt: now().toISOString(),
    },
    result,
  );

  return {
    ok: true,
    digest: readJudgmentDigest(store.db, sessionId, () => now().getTime()),
  };
}
