/**
 * The Codex adapters behind the harness ports: src/codex is "the Codex
 * implementation behind the ports". `codexReader` and `codexResolver` wrap the
 * existing pure Codex functions, they do not reimplement them, so the judge
 * path can depend on the port interfaces while the Codex behavior stays exactly
 * where it was.
 *
 * `codexReader.read` IS the S2 reader `rolloutRead`. `codexResolver.resolveCurrent`
 * wraps `resolveCurrentSession` (passing the harness home as the Codex home);
 * `codexResolver.locate` wraps `locateRolloutFile` and computes openness with
 * the same newest-is-open rule assess used to apply inline, now owned here.
 */
import { basename } from "node:path";
import { rolloutRead } from "../loader/rollout/codex-reader.ts";
import type { SessionResolver, TranscriptReader } from "../harness/ports.ts";
import { locateRolloutFile } from "./locate-rollout.ts";
import { newestRolloutName } from "./newest-rollout.ts";
import { resolveCurrentSession } from "./resolve-session.ts";

/** The Codex transcript reader: `read` is the S2 reader `rolloutRead`. */
export const codexReader: TranscriptReader = {
  read: rolloutRead,
};

/**
 * The Codex session resolver. `resolveCurrent` reads the per-cwd stamp (else the
 * newest rollout); `locate` finds the rollout file for a session id and marks it
 * open when it is the newest (live) rollout, the rule that decides whether the
 * reader force-closes the conversation.
 */
export const codexResolver: SessionResolver = {
  resolveCurrent(ctx) {
    return resolveCurrentSession({
      dataDir: ctx.dataDir,
      codexHome: ctx.harnessHome,
      cwd: ctx.cwd,
    });
  },
  locate(args) {
    const path = locateRolloutFile(args.sessionsDir, args.sessionId);
    if (path === null) return null;
    const open = newestRolloutName(args.sessionsDir) === basename(path);
    return { path, open };
  },
};
