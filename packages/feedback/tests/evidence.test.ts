/**
 * Evidence-layer read behavior, observed through readEvidenceDigest. Each
 * test seeds a store with the writer (openStore + insertEvent), then asserts
 * on the EvidenceDigest the reader returns. The clock is injected so the
 * staleness fields are deterministic.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent } from "../hooks/event-log.ts";
import { readEvidenceDigest } from "../src/evidence.ts";
import { openStore, type Store } from "../src/store.ts";

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-evidence-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sessionEvent(
  sessionId: string,
  event_type: "session.start" | "session.end",
  timestamp: string,
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "claude",
    model: "claude-opus-4-7",
    event_type,
    trace_id: traceIdFor(sessionId),
    span_phase: event_type === "session.start" ? "start" : "end",
    span_name: "session",
    attributes: {},
  };
}

function promptEvent(sessionId: string, timestamp: string): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "claude",
    event_type: "user_prompt",
    trace_id: traceIdFor(sessionId),
    span_phase: "point",
    span_name: "user_prompt",
    attributes: {},
  };
}

function compactionEvent(sessionId: string, timestamp: string): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "claude",
    event_type: "compaction",
    trace_id: traceIdFor(sessionId),
    span_phase: "point",
    span_name: "compaction",
    attributes: { trigger: "manual" },
  };
}

function toolEvent(
  sessionId: string,
  phase: "pre" | "post",
  timestamp: string,
  options: {
    tool_name?: string;
    tool_call_id?: string;
    file_path?: string;
  } = {},
): RegimenEvent {
  const toolName = options.tool_name ?? "Edit";
  const attributes: Record<string, string> = {
    tool_name: toolName,
    tool_call_id: options.tool_call_id ?? "toolu_abc",
  };
  if (options.file_path !== undefined) attributes.file_path = options.file_path;
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "claude",
    event_type: phase === "pre" ? "tool.pre" : "tool.post",
    trace_id: traceIdFor(sessionId),
    span_phase: phase === "pre" ? "start" : "end",
    span_name: `tool:${toolName}`,
    attributes,
  };
}

function gateDenialEvent(
  sessionId: string,
  timestamp: string,
  options: {
    gate_id?: string;
    tool_call_id?: string;
    tool_name?: string;
    reason?: string;
  } = {},
): RegimenEvent {
  const gateId = options.gate_id ?? "rm-rf-guard";
  const attributes: Record<string, string> = {
    gate_id: gateId,
    tool_name: options.tool_name ?? "Bash",
    tool_call_id: options.tool_call_id ?? "toolu_blocked",
  };
  if (options.reason !== undefined) attributes.reason = options.reason;
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "claude",
    event_type: "gate.denial",
    trace_id: traceIdFor(sessionId),
    span_phase: "point",
    span_name: `gate:${gateId}`,
    attributes,
  };
}

test("an unknown session id yields a known:false digest with the echoed id and generatedAt", () => {
  withStore((store) => {
    const at = Date.parse("2026-05-21T18:00:00.000Z");
    const digest = readEvidenceDigest(store.db, "never-seen", () => at);

    expect(digest.known).toBe(false);
    expect(digest.schemaVersion).toBe(1);
    expect(digest.sessionId).toBe("never-seen");
    expect(digest.generatedAt).toBe("2026-05-21T18:00:00.000Z");
    if (!digest.known) {
      expect(digest.note.length).toBeGreaterThan(0);
    }
  });
});

test("a conversation with a session.start yields a known:true digest with the conversation facet", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T17:00:00.000Z";
    store.insertEvent(sessionEvent("conv-1", "session.start", startedAt));

    const digest = readEvidenceDigest(store.db, "conv-1", () =>
      Date.parse("2026-05-21T18:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.conversation.harness).toBe("claude");
      expect(digest.conversation.model).toBe("claude-opus-4-7");
      expect(digest.conversation.startedAt).toBe(startedAt);
      expect(digest.conversation.firstEventAt).toBe(startedAt);
      expect(digest.conversation.lastEventAt).toBe(startedAt);
      expect(digest.conversation.endedAt).toBeNull();
    }
  });
});

test("the conversation facet carries the working directory projected from the session's events", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T17:00:00.000Z";
    store.insertEvent({
      ...sessionEvent("conv-cwd", "session.start", startedAt),
      cwd: "/home/mlo/dev/regimen",
    });

    const digest = readEvidenceDigest(store.db, "conv-cwd", () =>
      Date.parse("2026-05-21T18:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.conversation.cwd).toBe("/home/mlo/dev/regimen");
    }
  });
});

test("a conversation whose events carried no working directory reports cwd as null, never fabricated", () => {
  withStore((store) => {
    store.insertEvent(
      sessionEvent("conv-no-cwd", "session.start", "2026-05-21T17:00:00.000Z"),
    );

    const digest = readEvidenceDigest(store.db, "conv-no-cwd", () =>
      Date.parse("2026-05-21T18:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.conversation.cwd).toBeNull();
    }
  });
});

test("counts reflects the five conversation_counts aggregations over the session's events", () => {
  withStore((store) => {
    const s = "conv-counts";
    store.insertEvent(
      sessionEvent(s, "session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent(promptEvent(s, "2026-05-21T12:01:00.000Z"));
    store.insertEvent(promptEvent(s, "2026-05-21T12:01:30.000Z"));
    store.insertEvent(
      toolEvent(s, "pre", "2026-05-21T12:02:00.000Z", { tool_call_id: "t1" }),
    );
    store.insertEvent(compactionEvent(s, "2026-05-21T12:03:00.000Z"));
    store.insertEvent(
      gateDenialEvent(s, "2026-05-21T12:04:00.000Z", { tool_call_id: "t2" }),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.counts).toEqual({
        promptCount: 2,
        toolCallCount: 1,
        compactionCount: 1,
        gateDenialCount: 1,
        eventCount: 6,
      });
    }
  });
});

test("staleness derives openMs from startedAt and idleMs from lastEventAt against the injected clock", () => {
  withStore((store) => {
    const s = "conv-staleness";
    store.insertEvent(
      sessionEvent(s, "session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent(promptEvent(s, "2026-05-21T12:30:00.000Z"));

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.staleness.openMs).toBe(3_600_000);
      expect(digest.staleness.idleMs).toBe(1_800_000);
    }
  });
});

test("openMs is null when the conversation has events but no session.start was drained", () => {
  withStore((store) => {
    const s = "conv-no-start";
    store.insertEvent(promptEvent(s, "2026-05-21T12:00:00.000Z"));

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T12:05:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.conversation.startedAt).toBeNull();
      expect(digest.staleness.openMs).toBeNull();
      expect(digest.staleness.idleMs).toBe(300_000);
    }
  });
});

test("endedAt is set on the conversation facet once a session.end is drained", () => {
  withStore((store) => {
    const s = "conv-ended";
    store.insertEvent(
      sessionEvent(s, "session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent(
      sessionEvent(s, "session.end", "2026-05-21T12:45:00.000Z"),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.conversation.endedAt).toBe("2026-05-21T12:45:00.000Z");
    }
  });
});

test("toolMix has one entry per tool, with callCount, sorted by count descending", () => {
  withStore((store) => {
    const s = "conv-toolmix";
    const t = "2026-05-21T12:00:00.000Z";
    store.insertEvent(
      toolEvent(s, "pre", t, { tool_name: "Bash", tool_call_id: "b1" }),
    );
    store.insertEvent(
      toolEvent(s, "pre", t, { tool_name: "Bash", tool_call_id: "b2" }),
    );
    store.insertEvent(
      toolEvent(s, "pre", t, { tool_name: "Bash", tool_call_id: "b3" }),
    );
    store.insertEvent(
      toolEvent(s, "pre", t, { tool_name: "Read", tool_call_id: "r1" }),
    );
    store.insertEvent(
      toolEvent(s, "pre", t, { tool_name: "Read", tool_call_id: "r2" }),
    );
    store.insertEvent(
      toolEvent(s, "pre", t, { tool_name: "Edit", tool_call_id: "e1" }),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.toolMix).toEqual([
        { toolName: "Bash", callCount: 3 },
        { toolName: "Read", callCount: 2 },
        { toolName: "Edit", callCount: 1 },
      ]);
    }
  });
});

function skillEvent(
  sessionId: string,
  timestamp: string,
  skillName: string,
  toolCallId: string,
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: sessionId,
    harness: "claude",
    event_type: "tool.pre",
    trace_id: traceIdFor(sessionId),
    span_phase: "start",
    span_name: "tool:Skill",
    attributes: {
      tool_name: "Skill",
      tool_call_id: toolCallId,
      skill_name: skillName,
    },
  };
}

test("skillUsage reflects the skill-invocation table, sorted by invocationCount descending", () => {
  withStore((store) => {
    const s = "conv-skills";
    store.insertEvent(skillEvent(s, "2026-05-21T12:00:00.000Z", "tdd", "s1"));
    store.insertEvent(skillEvent(s, "2026-05-21T12:01:00.000Z", "tdd", "s2"));
    store.insertEvent(
      skillEvent(s, "2026-05-21T12:02:00.000Z", "brainstorming", "s3"),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.skillUsage).toEqual([
        {
          skillName: "tdd",
          invocationCount: 2,
          lastInvokedAt: "2026-05-21T12:01:00.000Z",
        },
        {
          skillName: "brainstorming",
          invocationCount: 1,
          lastInvokedAt: "2026-05-21T12:02:00.000Z",
        },
      ]);
    }
  });
});

test("repeatedFileEdits reflects the edit table, sorted by editCount descending", () => {
  withStore((store) => {
    const s = "conv-edits";
    store.insertEvent(
      toolEvent(s, "post", "2026-05-21T12:00:00.000Z", {
        tool_name: "Edit",
        tool_call_id: "a1",
        file_path: "src/a.ts",
      }),
    );
    store.insertEvent(
      toolEvent(s, "post", "2026-05-21T12:01:00.000Z", {
        tool_name: "Edit",
        tool_call_id: "a2",
        file_path: "src/a.ts",
      }),
    );
    store.insertEvent(
      toolEvent(s, "post", "2026-05-21T12:02:00.000Z", {
        tool_name: "Edit",
        tool_call_id: "a3",
        file_path: "src/a.ts",
      }),
    );
    store.insertEvent(
      toolEvent(s, "post", "2026-05-21T12:03:00.000Z", {
        tool_name: "Edit",
        tool_call_id: "b1",
        file_path: "src/b.ts",
      }),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.repeatedFileEdits).toEqual([
        {
          filePath: "src/a.ts",
          editCount: 3,
          lastEditedAt: "2026-05-21T12:02:00.000Z",
        },
        {
          filePath: "src/b.ts",
          editCount: 1,
          lastEditedAt: "2026-05-21T12:03:00.000Z",
        },
      ]);
    }
  });
});

test("gateDenials reflects the gate_denials table, with a null reason when none was given", () => {
  withStore((store) => {
    const s = "conv-denials";
    store.insertEvent(
      gateDenialEvent(s, "2026-05-21T12:00:00.000Z", {
        gate_id: "rm-rf-guard",
        tool_call_id: "d1",
        tool_name: "Bash",
        reason: "would rm -rf /",
      }),
    );
    store.insertEvent(
      gateDenialEvent(s, "2026-05-21T12:05:00.000Z", {
        gate_id: "no-force-push",
        tool_call_id: "d2",
        tool_name: "Bash",
      }),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T13:00:00.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.gateDenials).toEqual([
        {
          toolName: "Bash",
          gateId: "rm-rf-guard",
          toolCallId: "d1",
          reason: "would rm -rf /",
          deniedAt: "2026-05-21T12:00:00.000Z",
        },
        {
          toolName: "Bash",
          gateId: "no-force-push",
          toolCallId: "d2",
          reason: null,
          deniedAt: "2026-05-21T12:05:00.000Z",
        },
      ]);
    }
  });
});

test("a near-empty conversation reports real zero counts and empty arrays, not absent fields", () => {
  withStore((store) => {
    const s = "conv-tiny";
    store.insertEvent(
      sessionEvent(s, "session.start", "2026-05-21T12:00:00.000Z"),
    );

    const digest = readEvidenceDigest(store.db, s, () =>
      Date.parse("2026-05-21T12:00:30.000Z"),
    );

    expect(digest.known).toBe(true);
    if (digest.known) {
      expect(digest.counts).toEqual({
        promptCount: 0,
        toolCallCount: 0,
        compactionCount: 0,
        gateDenialCount: 0,
        eventCount: 1,
      });
      expect(digest.toolMix).toEqual([]);
      expect(digest.skillUsage).toEqual([]);
      expect(digest.repeatedFileEdits).toEqual([]);
      expect(digest.gateDenials).toEqual([]);
      expect(digest.staleness.openMs).toBe(30_000);
      expect(digest.staleness.idleMs).toBe(30_000);
    }
  });
});
