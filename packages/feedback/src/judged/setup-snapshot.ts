/**
 * The conversation-time setup-provenance snapshot writer (ADR-0017, migration
 * v7). `regimen assess` and the emit half of the agent seam both resolve the
 * engineer's setup as of one conversation's time; this module persists that
 * resolution as a time-scoped echo so the leverage audit can read "what setup
 * was in force" for a conversation without re-reading today's filesystem
 * (which would fault conversations that predate a lever).
 *
 * The snapshot stores practice NAMES and a per-convention content HASH, never
 * the convention text: it is provenance (what existed, and did it change), not
 * a second copy of the setup. Keyed by session id (the table's PRIMARY KEY),
 * so a re-assess upserts and the latest resolution wins.
 */
import { createHash } from "node:crypto";
import type { Store } from "../store.ts";
import type { EngineerSetup } from "./setup.ts";

/** Write (or replace) the setup snapshot for one conversation. */
export function writeSetupSnapshot(
  store: Store,
  sessionId: string,
  capturedAt: string,
  setup: EngineerSetup,
): void {
  const practices = setup.practices.map((practice) => ({
    name: practice.name,
  }));
  const conventions = setup.conventions.map((convention) => ({
    scope: convention.scope,
    sha256: createHash("sha256").update(convention.text).digest("hex"),
  }));
  store.db
    .prepare(
      `INSERT OR REPLACE INTO conversation_setup_snapshot
         (session_id, captured_at, practices, conventions)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      capturedAt,
      JSON.stringify(practices),
      JSON.stringify(conventions),
    );
}
