/**
 * Behavior of the Codex rollout tailer, observed through the sink it routes
 * events to. The tailer is the I/O shell; the completeness rule it applies
 * (newest rollout open, older rollouts complete) is the load-bearing
 * decision, so the tests assert which session gets a session.end.
 */
import { expect, jest, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegimenEvent } from "../hooks/event-log.ts";
import {
  startRolloutTailer,
  type QuarantinedRecord,
} from "../src/loader/rollout/tailer.ts";

const SAMPLES = join(import.meta.dir, "..", "samples");
const SHELL_SESSION = "019e0000-1111-7000-8000-000000000001";
const REAL_SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";

// The shell rollout's ISO stamp (06-02) is earlier than the real session's
// (06-03), so the real file is the newest (live) session, across day dirs.
const SHELL_FILE = "rollout-2026-06-02T10-00-00-000000000001.jsonl";
const REAL_FILE =
  "rollout-2026-06-03T00-16-25-019e8c20-4491-7ea3-b809-d6586a5a72b8.jsonl";

function withSessionsDir(fn: (sessionsDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "regimen-tailer-"));
  const shellDir = join(root, "2026", "06", "02");
  const realDir = join(root, "2026", "06", "03");
  mkdirSync(shellDir, { recursive: true });
  mkdirSync(realDir, { recursive: true });
  cpSync(
    join(SAMPLES, "rollout-shell-session.jsonl"),
    join(shellDir, SHELL_FILE),
  );
  cpSync(
    join(SAMPLES, "rollout-codex-session.jsonl"),
    join(realDir, REAL_FILE),
  );
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function endsFor(events: RegimenEvent[], sessionId: string): RegimenEvent[] {
  return events.filter(
    (e) => e.session_id === sessionId && e.event_type === "session.end",
  );
}

test("pollOnce routes events from every rollout in the sessions tree to the sink", () => {
  withSessionsDir((sessionsDir) => {
    const sink: RegimenEvent[] = [];
    const tailer = startRolloutTailer({
      sessionsDir,
      sink: (e) => sink.push(e),
    });
    tailer.pollOnce();
    tailer.stop();

    const starts = sink.filter((e) => e.event_type === "session.start");
    expect(starts.map((e) => e.session_id).sort()).toEqual(
      [SHELL_SESSION, REAL_SESSION].sort(),
    );
  });
});

test("intervalMs schedules repeated scans until stop halts them", () => {
  withSessionsDir((sessionsDir) => {
    jest.useFakeTimers();
    try {
      // Each scan re-reads both fixtures, so a growing sink proves a scan ran.
      let events = 0;
      const tailer = startRolloutTailer({
        sessionsDir,
        sink: () => {
          events += 1;
        },
        intervalMs: 1000,
      });

      expect(events).toBe(0); // nothing fires before the first tick
      jest.advanceTimersByTime(1000);
      const afterFirst = events;
      expect(afterFirst).toBeGreaterThan(0);
      jest.advanceTimersByTime(1000);
      expect(events).toBeGreaterThan(afterFirst);

      tailer.stop();
      const afterStop = events;
      jest.advanceTimersByTime(5000);
      expect(events).toBe(afterStop); // stop halts further scans
    } finally {
      jest.useRealTimers();
    }
  });
});

test("a malformed load-bearing record is surfaced to onQuarantine, not silently dropped", () => {
  const root = mkdtempSync(join(tmpdir(), "regimen-tailer-q-"));
  const dir = join(root, "2026", "06", "04");
  mkdirSync(dir, { recursive: true });
  const transcript = [
    JSON.stringify({
      timestamp: "2026-06-04T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "019e0000-0000-7000-8000-0000000000ff", source: "exec" },
    }),
    JSON.stringify({
      timestamp: "2026-06-04T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "moderator",
        content: [{ type: "input_text", text: "x" }],
      },
    }),
  ].join("\n");
  writeFileSync(
    join(dir, "rollout-2026-06-04T10-00-00-0000000000ff.jsonl"),
    transcript,
  );
  try {
    const quarantined: QuarantinedRecord[] = [];
    const tailer = startRolloutTailer({
      sessionsDir: root,
      sink: () => {},
      onQuarantine: (q) => quarantined.push(q),
    });
    tailer.pollOnce();
    tailer.stop();
    expect(quarantined.length).toBe(1);
    expect(quarantined[0]!.reason).toContain("moderator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the newest rollout is read open and every older rollout is read complete", () => {
  withSessionsDir((sessionsDir) => {
    const sink: RegimenEvent[] = [];
    const tailer = startRolloutTailer({
      sessionsDir,
      sink: (e) => sink.push(e),
    });
    tailer.pollOnce();
    tailer.stop();

    // The older shell transcript is finished: it gets a session.end.
    expect(endsFor(sink, SHELL_SESSION).length).toBe(1);
    // The newest (real) transcript is the live session: never force-closed.
    expect(endsFor(sink, REAL_SESSION).length).toBe(0);
  });
});
