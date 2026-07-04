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
import type { Harness } from "@regimen/shared";
import type { Store } from "../store.ts";
import { harnessSupport } from "../harness/support.ts";
import type { RegimenEvent } from "../../hooks/event-log.ts";
import { readJudgmentDigest, type JudgmentDigest } from "./digest.ts";
import { judgeConversation } from "./judge.ts";
import type { JudgeModelPort } from "./port.ts";
import type { EngineerSetup, SetupSource } from "./setup.ts";
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
  // Resolve the engineer's setup (the expected behaviors) only on the path that
  // actually judges, so an insufficient-evidence run does no setup I/O. The
  // injected source is optional: with none, setup stays undefined and the judge
  // is setup-blind, byte-identical to before. The setup is time-scoped to the
  // conversation, not to now (ADR-0016): see {@link conversationAsOf}.
  const setup =
    read.content.length > 0
      ? resolveSetup(options.setupSource, read.events, now)
      : undefined;

  const result: JudgeResult =
    read.content.length === 0
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
          { sessionId, chunks: read.content },
          {
            llm,
            now,
            setup,
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

/**
 * Resolve the engineer's setup for one conversation through the injected source,
 * time-scoped to the conversation and rooted at the conversation's working
 * directory. Returns undefined when no source is injected (the judge stays
 * setup-blind) or the source discovers nothing. Never falls back to the CLI's
 * own process cwd: an archived conversation that reported no cwd of its own
 * must resolve setup with no cwd, not silently against whatever repo `assess`
 * happens to be invoked from (e.g. during `assess --all` over other repos).
 */
function resolveSetup(
  source: SetupSource | undefined,
  events: ReadonlyArray<RegimenEvent>,
  now: () => Date,
): EngineerSetup | undefined {
  if (source === undefined) return undefined;
  return source.resolve({
    cwd: conversationCwd(events),
    asOf: conversationAsOf(events, now),
  });
}

/**
 * The conversation's representative instant for time-scoping the setup: the
 * latest structural event's timestamp, the same instant the rest of the system
 * treats as the conversation's time (`last_event_at`). The setup the judge
 * reasons against must be the setup as of the conversation, not as of now
 * (ADR-0016), so a conversation re-judged after the conventions changed is still
 * weighed against the conventions in force when it ran. Falls back to `now()`
 * when the read produced no parseable event timestamp.
 */
function conversationAsOf(
  events: ReadonlyArray<RegimenEvent>,
  now: () => Date,
): Date {
  let latest: number | undefined;
  for (const event of events) {
    const ms = Date.parse(event.timestamp);
    if (Number.isNaN(ms)) continue;
    if (latest === undefined || ms > latest) latest = ms;
  }
  return latest === undefined ? now() : new Date(latest);
}

/**
 * The working directory the conversation ran in: the first event that reported
 * one (a session-level anchor most events repeat). Undefined when no event
 * carried a cwd, so the caller falls back to the process cwd.
 */
function conversationCwd(
  events: ReadonlyArray<RegimenEvent>,
): string | undefined {
  for (const event of events) {
    if (event.cwd !== undefined && event.cwd.length > 0) return event.cwd;
  }
  return undefined;
}
