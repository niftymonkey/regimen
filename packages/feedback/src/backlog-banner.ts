/**
 * The session-start backlog banner: one terse line telling the engineer how
 * many captured conversations are still unassessed, and that assessment runs
 * only when they ask.
 *
 * A banner must NEVER break or slow a session start, so a failure to count
 * (store missing, locked, corrupt) and any unexpected throw degrade to
 * silence: the function returns null rather than throwing, and the caller (a
 * harness hook) writes nothing. A zero backlog is also silent. A politeness
 * cap shows the banner at most twice per calendar day, then stays quiet until
 * the next day; the seen-count is Regimen's own state, kept in a small JSON
 * record beside the store, and rolls over when the local date changes. A
 * malformed cap record self-heals (reads as absent, rewritten on the next
 * show) so one corrupt write never silences the banner for good.
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countUnassessed } from "./sessions.ts";

/** How many times a day the banner is allowed to show before going quiet. */
const DAILY_CAP = 2;

/** Regimen's own seen-count record, one per day, beside the store. */
interface ShowRecord {
  readonly date: string;
  readonly shows: number;
}

function bannerLine(count: number): string {
  const noun = count === 1 ? "conversation" : "conversations";
  return `regimen · ${count} ${noun} awaiting assessment (runs only when you ask; this notice shows a couple of times a day, then stays quiet until tomorrow)`;
}

/** The local calendar day (`YYYY-MM-DD`) the cap rolls over on. */
function localDay(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function statePath(dataDir: string): string {
  return join(dataDir, "backlog-banner.json");
}

/**
 * The shows-so-far for `today`. A missing record is a fresh day (zero shows); a
 * record from an earlier day has rolled over (zero shows). A malformed record
 * self-heals: it reads as absent (zero shows) rather than silencing the banner
 * permanently, and the next show rewrites it valid.
 */
function showsToday(dataDir: string, today: string): number {
  try {
    const record = JSON.parse(
      readFileSync(statePath(dataDir), "utf8"),
    ) as ShowRecord;
    if (typeof record.date !== "string" || typeof record.shows !== "number") {
      return 0;
    }
    return record.date === today ? record.shows : 0;
  } catch {
    return 0;
  }
}

function recordShow(dataDir: string, today: string, shows: number): void {
  const record: ShowRecord = { date: today, shows };
  writeFileSync(statePath(dataDir), `${JSON.stringify(record)}\n`);
}

export function backlogBanner(args: {
  dataDir: string;
  now?: () => Date;
}): string | null {
  try {
    const db = new Database(join(args.dataDir, "feedback.db"), {
      readonly: true,
    });
    let count: number;
    try {
      count = countUnassessed(db);
    } finally {
      db.close();
    }
    if (count === 0) return null;

    const today = localDay((args.now ?? (() => new Date()))());
    const shows = showsToday(args.dataDir, today);
    if (shows >= DAILY_CAP) return null;
    recordShow(args.dataDir, today, shows + 1);
    return bannerLine(count);
  } catch {
    return null;
  }
}
