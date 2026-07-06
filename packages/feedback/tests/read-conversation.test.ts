/**
 * The shared front-half preparation, focused on its one fail-closed error: a
 * missing transcript. prepareConversation must throw a TYPED
 * TranscriptNotFoundError (carrying the session id), so a sweep can classify the
 * gone-transcript case on the type rather than by matching a message string.
 *
 * A fake harness support whose resolver locates nothing drives the missing path
 * with no filesystem and no real adapter.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store.ts";
import type { HarnessSupport } from "../src/harness/support.ts";
import {
  prepareConversation,
  TranscriptNotFoundError,
} from "../src/judged/read-conversation.ts";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-prepare-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A support bundle whose resolver never finds a transcript. */
function supportLocatingNothing(): HarnessSupport {
  return {
    descriptor: {} as HarnessSupport["descriptor"],
    reader: {
      read() {
        throw new Error("reader must not run when the transcript is missing");
      },
    },
    resolver: {
      resolveCurrent: () => null,
      locate: () => null,
    },
  };
}

test("prepareConversation throws a typed TranscriptNotFoundError carrying the session id when the transcript is gone", () => {
  withStore((store) => {
    let thrown: unknown;
    try {
      prepareConversation({
        support: supportLocatingNothing(),
        sessionsDir: "/nowhere/sessions",
        sessionId: "gone-session",
        store,
        now: () => new Date("2026-07-05T00:00:00.000Z"),
      });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(TranscriptNotFoundError);
    expect((thrown as TranscriptNotFoundError).sessionId).toBe("gone-session");
  });
});
