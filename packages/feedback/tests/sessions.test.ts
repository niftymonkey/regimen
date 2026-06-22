/**
 * Session-selection read behavior, observed through listSessions (B.4).
 *
 * Each test seeds a temp store with conversation rows (inserted directly, as
 * the loader would), events (via the writer, so the count view is populated),
 * and judged rows (via writeAssessment), then asserts on what listSessions
 * reads back. The clock is injected so relative `since`/`until` offsets are
 * deterministic. Pure SQLite read: no Judge, no network, no writes.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStore, type Store } from "../src/store.ts";
import {
  writeAssessment,
  type AssessmentRunIdentity,
} from "../src/judged/writer.ts";
import type { JudgeResult, OutcomeValue } from "../src/judged/types.ts";
import { listSessions } from "../src/sessions.ts";

const NOW = () => Date.parse("2026-06-15T12:00:00.000Z");
const ASSIGNMENT = "whole-conversation";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-sessions-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Seed a session as the loader would: one prompt event (populating the count
 * view) plus a conversations row with explicit first/last event timestamps and
 * a chosen harness/model. Returns nothing; assertions read it back through
 * listSessions.
 */
function seedSession(
  db: Database,
  opts: {
    sessionId: string;
    harness: string;
    model: string | null;
    firstEventAt: string;
    lastEventAt: string;
    eventCount?: number;
  },
): void {
  const count = opts.eventCount ?? 1;
  for (let i = 0; i < count; i++) {
    // Insert events directly (not via the typed loader) so a test can seed an
    // arbitrary harness string; the count view reads the events table.
    db.prepare(
      `INSERT OR IGNORE INTO events
         (event_hash, schema_version, trace_id, session_id, timestamp,
          harness, model, event_type, span_phase, span_name, attributes)
       VALUES (randomblob(32), 1, ?, ?, ?, ?, ?, 'user_prompt', 'point', 'user_prompt', ?)`,
    ).run(
      `trace-${opts.sessionId}`,
      opts.sessionId,
      opts.lastEventAt,
      opts.harness,
      opts.model,
      JSON.stringify({ i: String(i) }),
    );
  }
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.sessionId,
    opts.harness,
    opts.model,
    opts.firstEventAt,
    opts.lastEventAt,
  );
}

function run(sessionId: string, runId: string): AssessmentRunIdentity {
  return {
    runId,
    sessionId,
    assignmentId: ASSIGNMENT,
    createdAt: "2026-06-15T10:00:00.000Z",
  };
}

/** A complete verdict carrying the given whole-conversation Outcome value. */
function resultWithOutcome(outcome: OutcomeValue): JudgeResult {
  return {
    complete: true,
    provenance: {
      judgeModel: "judge-model",
      rubricVersion: "2026-06-15",
      promptVersion: "2026-06-15",
    },
    signals: [
      {
        scope: "assignment",
        assignmentId: ASSIGNMENT,
        signalName: "outcome",
        valueKind: "ordinal",
        value: outcome,
        anchors: [{ eventHash: "b".repeat(64) }],
      },
    ],
    narratives: [
      {
        scope: "conversation",
        narrativeType: "assessment",
        prose: "The agent built the feature.",
        anchors: [{ eventHash: "a".repeat(64) }],
      },
    ],
  };
}

test("listSessions with no filter returns every session", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "sess-a",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    seedSession(store.db, {
      sessionId: "sess-b",
      harness: "gemini",
      model: "gemini-2.5",
      firstEventAt: "2026-06-14T09:00:00.000Z",
      lastEventAt: "2026-06-14T09:15:00.000Z",
    });
    const ids = listSessions(store.db, {}, NOW)
      .map((r) => r.sessionId)
      .sort();
    expect(ids).toEqual(["sess-a", "sess-b"]);
  });
});

test("listSessions orders newest lastEventAt first", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "older",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-13T08:00:00.000Z",
      lastEventAt: "2026-06-13T09:00:00.000Z",
    });
    seedSession(store.db, {
      sessionId: "newest",
      harness: "codex",
      model: "gpt-5",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T11:00:00.000Z",
    });
    seedSession(store.db, {
      sessionId: "middle",
      harness: "gemini",
      model: "gemini-2.5",
      firstEventAt: "2026-06-14T10:00:00.000Z",
      lastEventAt: "2026-06-14T10:30:00.000Z",
    });
    const ids = listSessions(store.db, {}, NOW).map((r) => r.sessionId);
    expect(ids).toEqual(["newest", "middle", "older"]);
  });
});

test("listSessions carries judged=true with the outcome for a judged session, and judged=false with a null outcome for an unjudged one", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "judged",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    writeAssessment(
      store,
      run("judged", "run-j"),
      resultWithOutcome("accomplished-cleanly"),
    );
    seedSession(store.db, {
      sessionId: "unjudged",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-14T10:00:00.000Z",
      lastEventAt: "2026-06-14T10:30:00.000Z",
    });
    const bySession = new Map(
      listSessions(store.db, {}, NOW).map((r) => [r.sessionId, r]),
    );
    expect(bySession.get("judged")!.judged).toBe(true);
    expect(bySession.get("judged")!.outcome).toBe("accomplished-cleanly");
    expect(bySession.get("unjudged")!.judged).toBe(false);
    expect(bySession.get("unjudged")!.outcome).toBeNull();
  });
});

test("listSessions reports eventCount and the lifecycle timestamps", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "counted",
      harness: "codex",
      model: "gpt-5",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:45:00.000Z",
      eventCount: 3,
    });
    const [row] = listSessions(store.db, {}, NOW);
    expect(row).toEqual({
      sessionId: "counted",
      harness: "codex",
      model: "gpt-5",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:45:00.000Z",
      eventCount: 3,
      judged: false,
      outcome: null,
    });
  });
});

test("listSessions surfaces model: null when the conversation model is null", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "nullmodel",
      harness: "codex",
      model: null,
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    const [row] = listSessions(store.db, {}, NOW);
    expect(row!.model).toBeNull();
  });
});

/** Seed three sessions across two harnesses and two models for filter tests. */
function seedMixed(store: Store): void {
  seedSession(store.db, {
    sessionId: "claude-opus",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T10:00:00.000Z",
    lastEventAt: "2026-06-15T10:30:00.000Z",
  });
  seedSession(store.db, {
    sessionId: "claude-sonnet",
    harness: "claude",
    model: "claude-sonnet-4-5",
    firstEventAt: "2026-06-15T09:00:00.000Z",
    lastEventAt: "2026-06-15T09:30:00.000Z",
  });
  seedSession(store.db, {
    sessionId: "gemini-pro",
    harness: "gemini",
    model: "gemini-2.5",
    firstEventAt: "2026-06-15T08:00:00.000Z",
    lastEventAt: "2026-06-15T08:30:00.000Z",
  });
}

test("listSessions filters by harness", () => {
  withStore((store) => {
    seedMixed(store);
    const ids = listSessions(store.db, { harness: "claude" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["claude-opus", "claude-sonnet"]);
  });
});

test("listSessions filters by model", () => {
  withStore((store) => {
    seedMixed(store);
    const ids = listSessions(store.db, { model: "claude-sonnet-4-5" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["claude-sonnet"]);
  });
});

test("listSessions filters by outcome", () => {
  withStore((store) => {
    seedSession(store.db, {
      sessionId: "clean",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T10:00:00.000Z",
      lastEventAt: "2026-06-15T10:30:00.000Z",
    });
    writeAssessment(
      store,
      run("clean", "run-clean"),
      resultWithOutcome("accomplished-cleanly"),
    );
    seedSession(store.db, {
      sessionId: "partial",
      harness: "claude",
      model: "claude-opus-4-8",
      firstEventAt: "2026-06-15T09:00:00.000Z",
      lastEventAt: "2026-06-15T09:30:00.000Z",
    });
    writeAssessment(
      store,
      run("partial", "run-partial"),
      resultWithOutcome("partial"),
    );
    const ids = listSessions(store.db, { outcome: "partial" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["partial"]);
  });
});

/** Seed sessions whose lastEventAt spans several days for window tests. */
function seedWindow(store: Store): void {
  seedSession(store.db, {
    sessionId: "day-10",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-10T08:00:00.000Z",
    lastEventAt: "2026-06-10T09:00:00.000Z",
  });
  seedSession(store.db, {
    sessionId: "day-13",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-13T08:00:00.000Z",
    lastEventAt: "2026-06-13T09:00:00.000Z",
  });
  seedSession(store.db, {
    sessionId: "day-15",
    harness: "claude",
    model: "claude-opus-4-8",
    firstEventAt: "2026-06-15T08:00:00.000Z",
    lastEventAt: "2026-06-15T11:30:00.000Z",
  });
}

test("listSessions filters by an ISO `since` date on lastEventAt", () => {
  withStore((store) => {
    seedWindow(store);
    const ids = listSessions(store.db, { since: "2026-06-13" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["day-15", "day-13"]);
  });
});

test("listSessions filters by an ISO `until` date on lastEventAt", () => {
  withStore((store) => {
    seedWindow(store);
    const ids = listSessions(store.db, { until: "2026-06-13" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["day-13", "day-10"]);
  });
});

test("listSessions filters by an ISO since/until window", () => {
  withStore((store) => {
    seedWindow(store);
    const ids = listSessions(
      store.db,
      { since: "2026-06-13", until: "2026-06-14" },
      NOW,
    ).map((r) => r.sessionId);
    expect(ids).toEqual(["day-13"]);
  });
});

test("listSessions resolves a relative `Nd` since offset against the injected now", () => {
  withStore((store) => {
    seedWindow(store);
    // NOW is 2026-06-15T12:00Z; 3d back is 2026-06-12T12:00Z, so only day-13
    // and day-15 (lastEventAt on/after that instant) match.
    const ids = listSessions(store.db, { since: "3d" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["day-15", "day-13"]);
  });
});

test("listSessions resolves a relative `Nh` since offset against the injected now", () => {
  withStore((store) => {
    seedWindow(store);
    // NOW is 2026-06-15T12:00Z; 6h back is 2026-06-15T06:00Z, so only day-15
    // (lastEventAt 11:30Z) matches.
    const ids = listSessions(store.db, { since: "6h" }, NOW).map(
      (r) => r.sessionId,
    );
    expect(ids).toEqual(["day-15"]);
  });
});

test("listSessions rejects an unparseable since value with a clear error", () => {
  withStore((store) => {
    seedWindow(store);
    expect(() =>
      listSessions(store.db, { since: "last-tuesday" }, NOW),
    ).toThrow(/could not parse since/);
  });
});

test("listSessions rejects an unparseable until value with a clear error", () => {
  withStore((store) => {
    seedWindow(store);
    expect(() => listSessions(store.db, { until: "soon" }, NOW)).toThrow(
      /could not parse until/,
    );
  });
});
