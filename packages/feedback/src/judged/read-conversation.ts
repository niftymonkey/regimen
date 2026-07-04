/**
 * The shared front-half of a judging pass: locate the transcript, read it once,
 * route quarantined records, insert the structural events (the load-bearing
 * anchor step so {eventHash} anchors resolve), and resolve the engineer's setup
 * as of the conversation. Extracted so the single-conversation assess spine and
 * the tier C agent seam (emit + record) compose the IDENTICAL preparation, since
 * an anchor that does not resolve the same way at emit, record, and in-process
 * judging would let the same conversation be judged against different evidence.
 *
 * Deterministic and idempotent: same transcript in, same chunks and events out;
 * insertEvent collapses on the event_hash PK so a re-read (emit then record, or a
 * daemon that already drained the rollout) writes nothing new.
 */
import { readFileSync } from "node:fs";
import type { RegimenEvent } from "../../hooks/event-log.ts";
import type { ContentChunk } from "../loader/reader-types.ts";
import type { HarnessSupport } from "../harness/support.ts";
import type { Store } from "../store.ts";
import type { EngineerSetup, SetupSource } from "./setup.ts";

export interface PrepareConversationOptions {
  /** The harness support bundle (resolver + reader) resolved by the caller. */
  readonly support: HarnessSupport;
  /** The harness sessions root, e.g. <harnessHome>/sessions. */
  readonly sessionsDir: string;
  readonly sessionId: string;
  readonly store: Store;
  /**
   * The injected source of the engineer's setup. Optional and additive: with
   * none, no setup is resolved and the judge stays setup-blind. The recorder
   * passes none (it validates an already-produced verdict, not a fresh prompt).
   */
  readonly setupSource?: SetupSource;
  /** Injectable clock for time-scoping the setup resolution. */
  readonly now: () => Date;
}

/** The prepared conversation: its content chunks, structural events, and setup. */
export interface PreparedConversation {
  readonly content: ContentChunk[];
  readonly events: RegimenEvent[];
  /** The engineer's setup as of the conversation, or undefined (setup-blind / no content). */
  readonly setup: EngineerSetup | undefined;
}

/**
 * Prepare one conversation for judging. Throws a clear error when the transcript
 * is missing (the only fail-closed case that errors, mirroring assess). The
 * setup is resolved only when the conversation yielded content, so an
 * insufficient-evidence pass does no setup I/O.
 */
export function prepareConversation(
  options: PrepareConversationOptions,
): PreparedConversation {
  const { support, sessionsDir, sessionId, store, now } = options;

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
  // event_hash PK.
  for (const event of read.events) {
    store.insertEvent(event);
  }

  const setup =
    read.content.length > 0
      ? resolveSetup(options.setupSource, read.events, now)
      : undefined;

  return { content: read.content, events: read.events, setup };
}

/**
 * Resolve the engineer's setup for one conversation through the injected source,
 * time-scoped to the conversation and rooted at the conversation's working
 * directory. Returns undefined when no source is injected (the judge stays
 * setup-blind) or the source discovers nothing. Never falls back to the CLI's
 * own process cwd: an archived conversation that reported no cwd of its own must
 * resolve setup with no cwd, not silently against whatever repo the command
 * happens to be invoked from.
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
 * (ADR-0016). Falls back to `now()` when the read produced no parseable event
 * timestamp.
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
 * carried a cwd.
 */
function conversationCwd(
  events: ReadonlyArray<RegimenEvent>,
): string | undefined {
  for (const event of events) {
    if (event.cwd !== undefined && event.cwd.length > 0) return event.cwd;
  }
  return undefined;
}
