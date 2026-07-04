/**
 * The session-start backlog banner: its wording, the twice-a-day politeness
 * cap, date rollover, and the hard property that any failure degrades to
 * silence rather than throwing into a session start.
 *
 * Each test seeds a real store in a temp data dir with a chosen number of
 * unassessed conversations, then observes the string (or null) the banner
 * returns. The clock is injected so the day boundary is deterministic.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { backlogBanner } from "../src/backlog-banner.ts";

const DAY_ONE = () => new Date("2026-07-04T09:00:00.000Z");
const DAY_TWO = () => new Date("2026-07-05T09:00:00.000Z");

/**
 * Run `fn` against a temp data dir seeded with `unassessed` unjudged
 * conversations in a real store. The store is closed before `fn` runs so the
 * banner opens it fresh, as it does in a live session.
 */
function withBacklog(unassessed: number, fn: (dataDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-banner-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    for (let i = 0; i < unassessed; i++) {
      store.db
        .prepare(
          `INSERT INTO conversations
             (session_id, harness, model, first_event_at, last_event_at)
           VALUES (?, 'claude', 'claude-opus-4-8', ?, ?)`,
        )
        .run(
          `sess-${i}`,
          "2026-07-04T08:00:00.000Z",
          "2026-07-04T08:30:00.000Z",
        );
    }
    store.close();
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the banner reads as the harness-styled line naming the unassessed count", () => {
  withBacklog(11, (dataDir) => {
    expect(backlogBanner({ dataDir, now: DAY_ONE })).toBe(
      "regimen · 11 conversations awaiting assessment (runs only when you ask; this notice shows a couple of times a day, then stays quiet until tomorrow)",
    );
  });
});

test("a backlog of one uses the singular noun", () => {
  withBacklog(1, (dataDir) => {
    expect(backlogBanner({ dataDir, now: DAY_ONE })).toBe(
      "regimen · 1 conversation awaiting assessment (runs only when you ask; this notice shows a couple of times a day, then stays quiet until tomorrow)",
    );
  });
});

test("a zero backlog is silent", () => {
  withBacklog(0, (dataDir) => {
    expect(backlogBanner({ dataDir, now: DAY_ONE })).toBeNull();
  });
});

test("the banner shows at most twice in one day, then stays silent", () => {
  withBacklog(3, (dataDir) => {
    expect(backlogBanner({ dataDir, now: DAY_ONE })).not.toBeNull();
    expect(backlogBanner({ dataDir, now: DAY_ONE })).not.toBeNull();
    expect(backlogBanner({ dataDir, now: DAY_ONE })).toBeNull();
    expect(backlogBanner({ dataDir, now: DAY_ONE })).toBeNull();
  });
});

test("the day boundary resets the cap so the banner shows again tomorrow", () => {
  withBacklog(3, (dataDir) => {
    backlogBanner({ dataDir, now: DAY_ONE });
    backlogBanner({ dataDir, now: DAY_ONE });
    expect(backlogBanner({ dataDir, now: DAY_ONE })).toBeNull();
    expect(backlogBanner({ dataDir, now: DAY_TWO })).not.toBeNull();
  });
});

test("a missing store degrades to silence rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-banner-nostore-"));
  try {
    expect(backlogBanner({ dataDir: dir, now: DAY_ONE })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt store file degrades to silence rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-banner-corrupt-"));
  try {
    writeFileSync(join(dir, "feedback.db"), "this is not a sqlite database");
    expect(backlogBanner({ dataDir: dir, now: DAY_ONE })).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed cap-state record self-heals: the banner shows and the record is rewritten valid", () => {
  withBacklog(3, (dataDir) => {
    const path = join(dataDir, "backlog-banner.json");
    writeFileSync(path, "{ not json");
    expect(backlogBanner({ dataDir, now: DAY_ONE })).not.toBeNull();
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      date: string;
      shows: number;
    };
    expect(record.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.shows).toBe(1);
  });
});
