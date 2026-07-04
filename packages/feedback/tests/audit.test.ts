/**
 * The leverage-audit deterministic core, observed through leverageAudit.
 *
 * The core is the source of truth for ALL numbers in an audit: per-practice
 * eligible/fired counts and the convention-adherence distribution come straight
 * from SQL, never from the synthesis model. Each test seeds conversations, their
 * setup snapshots (as `regimen assess` will write them, migration v7), the
 * skill_invocations firing facts (as the loader projects them, migration v3), and
 * convention-adherence verdicts (via the writer), then asserts the reads. Pure
 * SQLite: no Judge, no network.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStore, type Store } from "../src/store.ts";
import { leverageAudit } from "../src/judged/audit.ts";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-audit-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed a conversation row as the loader would, with a fixed time window. */
function seedConversation(
  db: Database,
  sessionId: string,
  at = "2026-06-15T10:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO conversations
       (session_id, harness, model, first_event_at, last_event_at)
     VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
  ).run(sessionId, at, at);
}

/** Seed a conversation-time setup snapshot: the practice roster in force then. */
function seedSnapshot(
  db: Database,
  sessionId: string,
  practiceNames: ReadonlyArray<string>,
  options: { capturedAt?: string; conventions?: ReadonlyArray<string> } = {},
): void {
  const capturedAt = options.capturedAt ?? "2026-06-15T10:00:00.000Z";
  const practices = JSON.stringify(practiceNames.map((name) => ({ name })));
  const conventions = JSON.stringify(
    (options.conventions ?? []).map((scope) => ({ scope, sha256: "x" })),
  );
  db.prepare(
    `INSERT INTO conversation_setup_snapshot
       (session_id, captured_at, practices, conventions)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, capturedAt, practices, conventions);
}

/** Seed a firing fact: the practice fired in this conversation. */
function seedFiring(db: Database, sessionId: string, skillName: string): void {
  db.prepare(
    `INSERT INTO skill_invocations
       (session_id, skill_name, invocation_count, last_invoked_at)
     VALUES (?, ?, 1, '2026-06-15T10:05:00.000Z')`,
  ).run(sessionId, skillName);
}

/** Seed a whole-conversation convention-adherence verdict on a conversation. */
function seedAdherence(db: Database, sessionId: string, value: string): void {
  db.prepare(
    `INSERT INTO judged_signal
       (session_id, scope, assignment_id, signal_name, value_kind, value, anchors, run_id)
     VALUES (?, 'conversation', '', 'convention-adherence', 'categorical', ?, '[]', ?)`,
  ).run(sessionId, JSON.stringify(value), `run-${sessionId}`);
}

test("an empty store yields no levers and no convention adherence", () => {
  withStore((store) => {
    const report = leverageAudit(store.db);
    expect(report.levers).toEqual([]);
    expect(report.conventionAdherence.buckets).toEqual([]);
  });
});

test("a conversation predating a practice never counts against it (time-scoping)", () => {
  withStore((store) => {
    // Two early conversations whose snapshot roster does NOT carry the practice:
    // it did not exist at their time, so their snapshots never listed it.
    for (const id of ["old-1", "old-2"]) {
      seedConversation(store.db, id, "2026-05-01T09:00:00.000Z");
      seedSnapshot(store.db, id, ["tdd"], {
        capturedAt: "2026-05-01T09:00:00.000Z",
      });
    }
    // Three later conversations, after the practice came into force, none firing.
    for (const id of ["new-1", "new-2", "new-3"]) {
      seedConversation(store.db, id, "2026-06-15T10:00:00.000Z");
      seedSnapshot(store.db, id, ["tdd", "work-router"]);
    }

    const workRouter = leverageAudit(store.db).levers.find(
      (l) => l.name === "work-router",
    );
    // Only the three post-introduction conversations are eligible; the two that
    // predate it are excluded, so it is idle across 3, not 5.
    expect(workRouter).toEqual({
      name: "work-router",
      eligibleSessions: 3,
      firedSessions: 0,
      health: "idle",
      inForceNow: false,
    });
  });
});

test("a practice in force across enough conversations but never firing reads as idle", () => {
  withStore((store) => {
    for (const id of ["a", "b", "c"]) {
      seedConversation(store.db, id);
      seedSnapshot(store.db, id, ["work-router"]);
    }
    // No firing rows: the silent non-firing the audit exists to catch.
    const report = leverageAudit(store.db);
    expect(report.levers).toEqual([
      {
        name: "work-router",
        eligibleSessions: 3,
        firedSessions: 0,
        health: "idle",
        inForceNow: false,
      },
    ]);
  });
});

test("the since window excludes conversations and their firing before it", () => {
  withStore((store) => {
    seedConversation(store.db, "old", "2026-05-01T09:00:00.000Z");
    seedSnapshot(store.db, "old", ["tdd"], {
      capturedAt: "2026-05-01T09:00:00.000Z",
    });
    seedFiring(store.db, "old", "tdd");
    for (const id of ["a", "b", "c"]) {
      seedConversation(store.db, id, "2026-06-15T10:00:00.000Z");
      seedSnapshot(store.db, id, ["tdd"]);
    }

    const report = leverageAudit(store.db, {
      filter: { since: "2026-06-01T00:00:00.000Z" },
    });
    // Only the three June conversations are in the window; the May one and its
    // firing drop out entirely.
    expect(report.levers[0]?.eligibleSessions).toBe(3);
    expect(report.levers[0]?.firedSessions).toBe(0);
    expect(report.levers[0]?.health).toBe("idle");
  });
});

test("the convention-adherence distribution counts each value across the window", () => {
  withStore((store) => {
    for (const [id, value] of [
      ["a", "followed"],
      ["b", "followed"],
      ["c", "violated"],
    ] as const) {
      seedConversation(store.db, id);
      seedAdherence(store.db, id, value);
    }
    // A conversation with no conventions in force abstains (no row): it must not
    // appear in the distribution.
    seedConversation(store.db, "d");

    const report = leverageAudit(store.db);
    expect(report.conventionAdherence.buckets).toEqual([
      { value: "followed", count: 2 },
      { value: "violated", count: 1 },
    ]);
  });
});

test("a live practice no snapshot has carried reads as too-new and in force now", () => {
  withStore((store) => {
    // A brand-new practice: currently in force, but no conversation has run under
    // it yet, so it has zero eligible conversations.
    const report = leverageAudit(store.db, {
      currentLevers: ["brainstorming"],
    });
    expect(report.levers).toEqual([
      {
        name: "brainstorming",
        eligibleSessions: 0,
        firedSessions: 0,
        health: "too-new",
        inForceNow: true,
      },
    ]);
  });
});

test("a practice with too few eligible conversations reads as too-new, not idle", () => {
  withStore((store) => {
    for (const id of ["a", "b"]) {
      seedConversation(store.db, id);
      seedSnapshot(store.db, id, ["carryover"]);
    }
    // Only two eligible conversations, below the default floor of three.
    const report = leverageAudit(store.db);
    expect(report.levers[0]?.health).toBe("too-new");
    expect(report.levers[0]?.eligibleSessions).toBe(2);
  });
});

test("a practice that fires in its eligible conversations reads as working", () => {
  withStore((store) => {
    for (const id of ["a", "b", "c"]) {
      seedConversation(store.db, id);
      seedSnapshot(store.db, id, ["tdd"]);
    }
    seedFiring(store.db, "a", "tdd");
    seedFiring(store.db, "b", "tdd");

    const report = leverageAudit(store.db);

    expect(report.levers).toEqual([
      {
        name: "tdd",
        eligibleSessions: 3,
        firedSessions: 2,
        health: "working",
        inForceNow: false,
      },
    ]);
  });
});
