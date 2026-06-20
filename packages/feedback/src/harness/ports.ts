/**
 * The two harness behavior PORTS: the interfaces the judge path depends on so
 * it never names a harness. A harness's adapters (the Codex ones live in
 * src/codex) implement these; the registry (support.ts) binds a harness to its
 * adapter pair. assess and the assess CLI program against these types only.
 *
 * `TranscriptReader` reads a whole transcript's text into the harness-agnostic
 * `RolloutReadResult`. `SessionResolver` answers the two filesystem questions
 * the judge path asks: which session is live in a cwd, and where a session's
 * transcript file is (with whether that file is the open/live one).
 *
 * The `RolloutReadResult`/`RolloutReadOptions` types are harness-agnostic; they
 * happen to live in the codex-reader module today, which is fine for Leg A.
 */
import type {
  RolloutReadOptions,
  RolloutReadResult,
} from "../loader/rollout/codex-reader.ts";

/** Reads a whole transcript's text into the harness-agnostic read result. */
export interface TranscriptReader {
  read(content: string, options: RolloutReadOptions): RolloutReadResult;
}

/**
 * A located transcript file: its path, and whether it is the open (live)
 * session. `open: true` means the resolver judged this the newest/live
 * transcript, so the reader treats it as incomplete (never force-closed).
 */
export interface LocatedSession {
  readonly path: string;
  readonly open: boolean;
}

/** The inputs a resolver needs to find the live session for a cwd. */
export interface ResolveContext {
  readonly dataDir: string;
  readonly harnessHome: string;
  readonly cwd: string;
}

/**
 * Resolves sessions for one harness. `resolveCurrent` answers "which session is
 * live in this cwd" (null when none); `locate` maps a session id to its
 * transcript file and openness (null when no file matches, the fail-closed
 * missing-transcript signal).
 */
export interface SessionResolver {
  resolveCurrent(ctx: ResolveContext): string | null;
  locate(args: {
    sessionsDir: string;
    sessionId: string;
  }): LocatedSession | null;
}
