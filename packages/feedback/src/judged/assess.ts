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
import { readFileSync } from "node:fs";
import type { Harness } from "../../hooks/event-log.ts";
import type { Store } from "../store.ts";
import { harnessSupport } from "../harness/support.ts";
import { readJudgmentDigest, type JudgmentDigest } from "./digest.ts";
import { judgeConversation } from "./judge.ts";
import type { JudgeModelPort } from "./port.ts";
import type { JudgeResult } from "./types.ts";
import { writeAssessment } from "./writer.ts";

const WHOLE_CONVERSATION_ASSIGNMENT = "whole-conversation";

/** The date-stamped provenance v1 stamps on an evidence-starved run. */
const DEFAULT_RUBRIC_VERSION = "2026-06-15";
const DEFAULT_PROMPT_VERSION = "2026-06-15";

export interface AssessOptions {
  readonly store: Store;
  /** The harness whose support bundle (resolver + reader) assess uses. */
  readonly harness: Harness;
  /** The harness sessions root, e.g. <harnessHome>/sessions. */
  readonly sessionsDir: string;
  readonly sessionId: string;
  /** The injected Judge model port; tests pass a deterministic stub. */
  readonly llm: JudgeModelPort;
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

  // Locate the transcript and its open state through the resolver port; the
  // newest/live rollout is open so assess never force-closes a conversation it
  // judged mid-flight (section 9.5). assess stays the I/O composition root.
  const located = support.resolver.locate({ sessionsDir, sessionId });
  if (located === null) {
    throw new Error(
      `no rollout transcript found for session ${sessionId} under ${sessionsDir}`,
    );
  }

  const content = readFileSync(located.path, "utf8");

  const read = support.reader.read(content, { complete: !located.open });

  // Surface the reader's fail-closed diagnostics (ADR-0007): route quarantined
  // load-bearing records to the store, and report unknown record types so
  // vendor drift stays visible.
  for (const record of read.quarantined) {
    store.quarantine(record.rawLine, record.reason);
  }
  if (Object.keys(read.unknownRecordTypes).length > 0) {
    process.stderr.write(
      `unknown rollout record types: ${JSON.stringify(read.unknownRecordTypes)}\n`,
    );
  }

  // The load-bearing anchor step (section 4): insert every structural event so
  // the content chunks' {eventHash} anchors resolve to rows. Idempotent via the
  // event_hash PK, so a re-run or a daemon that already drained this rollout
  // collapses harmlessly.
  for (const event of read.events) {
    store.insertEvent(event);
  }

  // Insufficient evidence (section 5.2): a transcript that yields zero content
  // chunks gives the judge nothing to ground a signal on. Record an honest
  // incomplete run with no fabricated signal, never calling the judge (it
  // requires a non-empty conversation as a caller contract). The structural
  // events are still inserted above, so the record stays valid.
  const result: JudgeResult =
    read.content.length === 0
      ? {
          complete: false,
          provenance: {
            judgeModel: "none",
            rubricVersion: DEFAULT_RUBRIC_VERSION,
            promptVersion: DEFAULT_PROMPT_VERSION,
          },
          signals: [],
          narratives: [],
          incompleteReason: "insufficient-evidence",
        }
      : await judgeConversation(
          { sessionId, chunks: read.content },
          { llm, now },
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
