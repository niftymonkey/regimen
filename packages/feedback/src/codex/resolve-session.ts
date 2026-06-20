/**
 * Resolve the session id of the Codex conversation that is live in a given
 * working directory, so the in-session evidence skill can read its own signals.
 *
 * Codex exposes no session-id environment variable to the agent's shell, so
 * resolution is filesystem-based and follows the Phase 0.6 approach. Precedence:
 *
 *   1. The per-cwd stamp the SessionStart hook writes (cwd-precise).
 *   2. Zero-config fallback: the most-recent-active session, taken as the newest
 *      rollout transcript by mtime under `CODEX_HOME/sessions`.
 *
 * The fallback reads only the rollout file *name*: the trailing UUID is the
 * session id (equal to `session_meta.id` and the `state_5.threads` id), so no
 * file is opened. `state_5.threads` is a convenience index, not a contract, so
 * the rollout files stay the source of truth. The open edge is two concurrent
 * sessions in one cwd, which the stamp cannot disambiguate.
 *
 * This module is Codex-specific; the generic evidence read side and the
 * `EvidenceDigest` contract stay harness-agnostic.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readSessionStamp } from "./session-stamp.ts";

/** Return env[key] if it is a non-empty string, otherwise undefined. */
function readEnv(
  env: Partial<NodeJS.ProcessEnv>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The Codex home directory: `CODEX_HOME` if set, else `~/.codex`. Mirrors
 * `resolveDataDir` by taking the environment and home directory as arguments
 * so callers under test pass fixed inputs.
 */
export function resolveCodexHome(
  env: Partial<NodeJS.ProcessEnv>,
  home: string,
): string {
  return readEnv(env, "CODEX_HOME") ?? join(home, ".codex");
}

export function resolveCurrentSession(args: {
  dataDir: string;
  codexHome: string;
  cwd: string;
}): string | null {
  const stamped = readSessionStamp({
    dataDir: args.dataDir,
    harness: "codex",
    cwd: args.cwd,
  });
  if (stamped !== null) return stamped;
  return newestRolloutSession(join(args.codexHome, "sessions"));
}

const ROLLOUT_FILE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * The session id of the newest rollout under `sessionsDir`, by file mtime, or
 * null when the tree has no rollout files. mtime tracks last activity, so the
 * newest is the most-recently-active session; the id is read from the file name
 * (no file is opened).
 */
function newestRolloutSession(sessionsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return null;
  }
  let newestMtime = -Infinity;
  let newestSession: string | null = null;
  for (const entry of entries) {
    const match = ROLLOUT_FILE.exec(basename(entry));
    if (match === null) continue;
    let mtime: number;
    try {
      mtime = statSync(join(sessionsDir, entry)).mtimeMs;
    } catch {
      // The file was rotated or removed between the scan and the stat; skip it.
      continue;
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestSession = match[1] ?? null;
    }
  }
  return newestSession;
}
