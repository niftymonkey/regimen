/**
 * The Codex "current session" stamp: a per-cwd record of which session id is
 * live in a given working directory.
 *
 * Codex, unlike Claude Code, exposes no session-id environment variable to the
 * agent's shell, so the in-session evidence skill cannot read its own session
 * id directly. The SessionStart hook writes this stamp (the producer) and the
 * session resolver reads it (the consumer); keeping the path, the cwd encoding,
 * and the record shape in one module is what stops the two sides drifting.
 *
 * One file per cwd, keyed by a hash of the cwd, so distinct working directories
 * never collide and a write is a whole-file replace rather than a
 * read-modify-write. Two sessions sharing one cwd is the documented open edge:
 * the last SessionStart wins.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Harness } from "../../hooks/event-log.ts";

interface StampRecord {
  sessionId: string;
  cwd: string;
  stampedAt: string;
}

/**
 * The stamp file for one cwd, under the Regimen data directory, partitioned by
 * harness so distinct harnesses never collide on the same cwd. One file per
 * (harness, cwd), keyed by a hash of the cwd.
 */
function stampPath(dataDir: string, harness: Harness, cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex");
  return join(dataDir, harness, "sessions", `${key}.json`);
}

/**
 * Record `sessionId` as the live session for `cwd` under `harness`. Overwrites
 * any prior stamp for the same (harness, cwd) (last SessionStart wins).
 */
export function writeSessionStamp(args: {
  dataDir: string;
  harness: Harness;
  cwd: string;
  sessionId: string;
}): void {
  const path = stampPath(args.dataDir, args.harness, args.cwd);
  mkdirSync(dirname(path), { recursive: true });
  const record: StampRecord = {
    sessionId: args.sessionId,
    cwd: args.cwd,
    stampedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

/** The stamped session id for `cwd` under `harness`, or null if none. */
export function readSessionStamp(args: {
  dataDir: string;
  harness: Harness;
  cwd: string;
}): string | null {
  const path = stampPath(args.dataDir, args.harness, args.cwd);
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as StampRecord;
    return typeof record.sessionId === "string" ? record.sessionId : null;
  } catch {
    return null;
  }
}
