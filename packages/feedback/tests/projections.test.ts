/**
 * Deterministic-signal projection behavior, observed through the store's
 * read surface. Each test inserts events through insertEvent and asserts
 * what becomes queryable in the signal tables ADR-0006 names.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceIdFor } from "@regimen/shared";
import { type RegimenEvent } from "../hooks/event-log.ts";
import { openStore, type Store } from "../src/store.ts";

const SESSION = "session-projection-1";

function sessionEvent(
  event_type: "session.start" | "session.end",
  timestamp: string,
  attributes: Record<string, string> = {},
): RegimenEvent {
  return {
    schema_version: 1,
    timestamp,
    session_id: SESSION,
    harness: "claude",
    model: "claude-opus-4-7",
    event_type,
    trace_id: traceIdFor(SESSION),
    span_phase: event_type === "session.start" ? "start" : "end",
    span_name: "session",
    attributes,
  };
}

function gateDenialEvent(
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
    session_id: SESSION,
    harness: "claude",
    event_type: "gate.denial",
    trace_id: traceIdFor(SESSION),
    span_phase: "point",
    span_name: `gate:${gateId}`,
    attributes,
  };
}

function toolEvent(
  phase: "pre" | "post",
  timestamp: string,
  options: {
    tool_name?: string;
    tool_call_id?: string;
    file_path?: string;
    skill_name?: string;
  } = {},
): RegimenEvent {
  const toolName = options.tool_name ?? "Edit";
  const attributes: Record<string, string> = {
    tool_name: toolName,
    tool_call_id: options.tool_call_id ?? "toolu_abc",
  };
  if (options.file_path !== undefined) attributes.file_path = options.file_path;
  if (options.skill_name !== undefined)
    attributes.skill_name = options.skill_name;
  return {
    schema_version: 1,
    timestamp,
    session_id: SESSION,
    harness: "claude",
    event_type: phase === "pre" ? "tool.pre" : "tool.post",
    trace_id: traceIdFor(SESSION),
    span_phase: phase === "pre" ? "start" : "end",
    span_name: `tool:${toolName}`,
    attributes,
  };
}

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-projection-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Read tool.post does not count as a file edit even when it carries file_path", () => {
  withStore((store) => {
    store.insertEvent(
      toolEvent("post", "2026-05-21T12:20:00.000Z", {
        tool_name: "Read",
        tool_call_id: "toolu_read_1",
        file_path: "/repo/src/store.ts",
      }),
    );

    const count = (
      store.db
        .prepare("SELECT COUNT(*) AS n FROM repeated_file_edits")
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});

test("a Codex apply_patch tool.post carrying file_path counts as a file edit", () => {
  withStore((store) => {
    const editedAt = "2026-06-02T11:00:01.500Z";
    store.insertEvent(
      toolEvent("post", editedAt, {
        tool_name: "apply_patch",
        tool_call_id: "call_patch01",
        file_path: "/work/sample-project/src/a.ts",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT edit_count, last_edited_at FROM repeated_file_edits WHERE session_id = ? AND file_path = ?",
      )
      .get(SESSION, "/work/sample-project/src/a.ts") as
      | Record<string, unknown>
      | undefined;

    expect(row?.edit_count).toBe(1);
    expect(row?.last_edited_at).toBe(editedAt);
  });
});

test("two Edits to the same file in one session increment edit_count to 2 and track the latest timestamp", () => {
  withStore((store) => {
    const first = "2026-05-21T12:10:00.000Z";
    const second = "2026-05-21T12:15:00.000Z";
    store.insertEvent(
      toolEvent("post", first, {
        tool_name: "Edit",
        tool_call_id: "toolu_edit_a",
        file_path: "/repo/src/store.ts",
      }),
    );
    store.insertEvent(
      toolEvent("post", second, {
        tool_name: "Edit",
        tool_call_id: "toolu_edit_b",
        file_path: "/repo/src/store.ts",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT edit_count, last_edited_at FROM repeated_file_edits WHERE session_id = ? AND file_path = ?",
      )
      .get(SESSION, "/repo/src/store.ts") as
      | Record<string, unknown>
      | undefined;

    expect(row?.edit_count).toBe(2);
    expect(row?.last_edited_at).toBe(second);
  });
});

test("Edit tool.post creates a repeated_file_edits row with edit_count = 1 for that file", () => {
  withStore((store) => {
    const editedAt = "2026-05-21T12:10:00.000Z";
    store.insertEvent(
      toolEvent("post", editedAt, {
        tool_name: "Edit",
        tool_call_id: "toolu_edit_1",
        file_path: "/repo/src/store.ts",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT edit_count, last_edited_at FROM repeated_file_edits WHERE session_id = ? AND file_path = ?",
      )
      .get(SESSION, "/repo/src/store.ts") as
      | Record<string, unknown>
      | undefined;

    expect(row?.edit_count).toBe(1);
    expect(row?.last_edited_at).toBe(editedAt);
  });
});

test("a Skill tool.pre records a skill_invocations row keyed by skill_name", () => {
  withStore((store) => {
    const invokedAt = "2026-05-21T12:40:00.000Z";
    store.insertEvent(
      toolEvent("pre", invokedAt, {
        tool_name: "Skill",
        tool_call_id: "toolu_skill_1",
        skill_name: "tdd",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT invocation_count, last_invoked_at FROM skill_invocations WHERE session_id = ? AND skill_name = ?",
      )
      .get(SESSION, "tdd") as Record<string, unknown> | undefined;

    expect(row?.invocation_count).toBe(1);
    expect(row?.last_invoked_at).toBe(invokedAt);
  });
});

test("two invocations of the same skill increment invocation_count and track the latest timestamp", () => {
  withStore((store) => {
    const first = "2026-05-21T12:40:00.000Z";
    const second = "2026-05-21T12:50:00.000Z";
    store.insertEvent(
      toolEvent("pre", first, {
        tool_name: "Skill",
        tool_call_id: "toolu_skill_a",
        skill_name: "tdd",
      }),
    );
    store.insertEvent(
      toolEvent("pre", second, {
        tool_name: "Skill",
        tool_call_id: "toolu_skill_b",
        skill_name: "tdd",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT invocation_count, last_invoked_at FROM skill_invocations WHERE session_id = ? AND skill_name = ?",
      )
      .get(SESSION, "tdd") as Record<string, unknown> | undefined;

    expect(row?.invocation_count).toBe(2);
    expect(row?.last_invoked_at).toBe(second);
  });
});

test("a Skill tool.post does not double-count an invocation already counted on its tool.pre", () => {
  withStore((store) => {
    store.insertEvent(
      toolEvent("pre", "2026-05-21T12:40:00.000Z", {
        tool_name: "Skill",
        tool_call_id: "toolu_skill_1",
        skill_name: "tdd",
      }),
    );
    store.insertEvent(
      toolEvent("post", "2026-05-21T12:40:00.500Z", {
        tool_name: "Skill",
        tool_call_id: "toolu_skill_1",
        skill_name: "tdd",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT invocation_count FROM skill_invocations WHERE session_id = ? AND skill_name = ?",
      )
      .get(SESSION, "tdd") as Record<string, unknown> | undefined;

    expect(row?.invocation_count).toBe(1);
  });
});

test("conversation_counts view exposes per-session single-event aggregations over events", () => {
  withStore((store) => {
    store.insertEvent(
      sessionEvent("session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent({
      schema_version: 1,
      timestamp: "2026-05-21T12:01:00.000Z",
      session_id: SESSION,
      harness: "claude",
      event_type: "user_prompt",
      trace_id: traceIdFor(SESSION),
      span_phase: "point",
      span_name: "user_prompt",
      attributes: {},
    });
    store.insertEvent({
      schema_version: 1,
      timestamp: "2026-05-21T12:01:30.000Z",
      session_id: SESSION,
      harness: "claude",
      event_type: "user_prompt",
      trace_id: traceIdFor(SESSION),
      span_phase: "point",
      span_name: "user_prompt",
      attributes: {},
    });
    store.insertEvent(
      toolEvent("pre", "2026-05-21T12:02:00.000Z", {
        tool_call_id: "toolu_x",
      }),
    );
    store.insertEvent({
      schema_version: 1,
      timestamp: "2026-05-21T12:03:00.000Z",
      session_id: SESSION,
      harness: "claude",
      event_type: "compaction",
      trace_id: traceIdFor(SESSION),
      span_phase: "point",
      span_name: "compaction",
      attributes: { trigger: "manual" },
    });
    store.insertEvent(
      gateDenialEvent("2026-05-21T12:04:00.000Z", {
        tool_call_id: "toolu_blocked",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT prompt_count, tool_call_count, compaction_count, gate_denial_count, event_count FROM conversation_counts WHERE session_id = ?",
      )
      .get(SESSION) as Record<string, unknown>;

    expect(row.prompt_count).toBe(2);
    expect(row.tool_call_count).toBe(1);
    expect(row.compaction_count).toBe(1);
    expect(row.gate_denial_count).toBe(1);
    expect(row.event_count).toBe(6);
  });
});

test("gate.denial inserts a gate_denials row capturing gate_id, tool_call_id, tool_name, reason, and timestamp", () => {
  withStore((store) => {
    const deniedAt = "2026-05-21T12:30:00.000Z";
    store.insertEvent(
      gateDenialEvent(deniedAt, {
        gate_id: "rm-rf-guard",
        tool_call_id: "toolu_blocked_42",
        tool_name: "Bash",
        reason: "would rm -rf /",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT session_id, tool_call_id, gate_id, tool_name, reason, denied_at FROM gate_denials WHERE gate_id = ? AND tool_call_id = ?",
      )
      .get("rm-rf-guard", "toolu_blocked_42") as
      | Record<string, unknown>
      | undefined;

    expect(row?.session_id).toBe(SESSION);
    expect(row?.gate_id).toBe("rm-rf-guard");
    expect(row?.tool_call_id).toBe("toolu_blocked_42");
    expect(row?.tool_name).toBe("Bash");
    expect(row?.reason).toBe("would rm -rf /");
    expect(row?.denied_at).toBe(deniedAt);
  });
});

test("a gate.denial on a tool_call_id fills denied_by_gate_id on the matching tool_call_spans row", () => {
  withStore((store) => {
    store.insertEvent(
      toolEvent("pre", "2026-05-21T12:05:00.000Z", {
        tool_name: "Bash",
        tool_call_id: "toolu_blocked_1",
      }),
    );
    store.insertEvent(
      gateDenialEvent("2026-05-21T12:05:00.100Z", {
        gate_id: "rm-rf-guard",
        tool_call_id: "toolu_blocked_1",
        tool_name: "Bash",
        reason: "would rm -rf /",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT denied_by_gate_id, ended_at FROM tool_call_spans WHERE tool_call_id = ?",
      )
      .get("toolu_blocked_1") as Record<string, unknown> | undefined;

    expect(row?.denied_by_gate_id).toBe("rm-rf-guard");
    expect(row?.ended_at).toBeNull();
  });
});

test("a matching tool.post fills ended_at and computes duration_ms from the timestamps", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T12:05:00.000Z";
    const endedAt = "2026-05-21T12:05:00.500Z";
    store.insertEvent(
      toolEvent("pre", startedAt, { tool_call_id: "toolu_pair_2" }),
    );
    store.insertEvent(
      toolEvent("post", endedAt, { tool_call_id: "toolu_pair_2" }),
    );

    const row = store.db
      .prepare(
        "SELECT started_at, ended_at, duration_ms FROM tool_call_spans WHERE tool_call_id = ?",
      )
      .get("toolu_pair_2") as Record<string, unknown> | undefined;

    expect(row?.started_at).toBe(startedAt);
    expect(row?.ended_at).toBe(endedAt);
    expect(row?.duration_ms).toBe(500);
  });
});

test("tool.pre inserts a tool_call_spans row with started_at and unpaired ended_at and duration_ms", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T12:05:00.000Z";
    store.insertEvent(
      toolEvent("pre", startedAt, {
        tool_name: "Edit",
        tool_call_id: "toolu_pair_1",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT session_id, tool_call_id, tool_name, started_at, ended_at, duration_ms, denied_by_gate_id FROM tool_call_spans WHERE tool_call_id = ?",
      )
      .get("toolu_pair_1") as Record<string, unknown> | undefined;

    expect(row?.session_id).toBe(SESSION);
    expect(row?.tool_name).toBe("Edit");
    expect(row?.started_at).toBe(startedAt);
    expect(row?.ended_at).toBeNull();
    expect(row?.duration_ms).toBeNull();
    expect(row?.denied_by_gate_id).toBeNull();
  });
});

test("any event for a session bumps last_event_at while the session stays open", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T12:00:00.000Z";
    const promptAt = "2026-05-21T12:10:00.000Z";
    store.insertEvent(sessionEvent("session.start", startedAt));
    store.insertEvent({
      schema_version: 1,
      timestamp: promptAt,
      session_id: SESSION,
      harness: "claude",
      event_type: "user_prompt",
      trace_id: traceIdFor(SESSION),
      span_phase: "point",
      span_name: "user_prompt",
      attributes: {},
    });

    const row = store.db
      .prepare(
        "SELECT session_started_at, session_ended_at, last_event_at FROM conversations WHERE session_id = ?",
      )
      .get(SESSION) as Record<string, unknown> | undefined;

    expect(row?.session_started_at).toBe(startedAt);
    expect(row?.session_ended_at).toBeNull();
    expect(row?.last_event_at).toBe(promptAt);
  });
});

test("session.end fills session_ended_at on the existing conversations row", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T12:00:00.000Z";
    const endedAt = "2026-05-21T12:34:56.000Z";
    store.insertEvent(sessionEvent("session.start", startedAt));
    store.insertEvent(sessionEvent("session.end", endedAt));

    const row = store.db
      .prepare(
        "SELECT session_started_at, session_ended_at, last_event_at FROM conversations WHERE session_id = ?",
      )
      .get(SESSION) as Record<string, unknown> | undefined;

    expect(row?.session_started_at).toBe(startedAt);
    expect(row?.session_ended_at).toBe(endedAt);
    expect(row?.last_event_at).toBe(endedAt);
  });
});

test("session.end records the native and normalized end reason on the conversations row", () => {
  withStore((store) => {
    store.insertEvent(
      sessionEvent("session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent(
      sessionEvent("session.end", "2026-05-21T12:34:56.000Z", {
        end_reason_native: "prompt_input_exit",
        end_reason_normalized: "user_exit",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT session_end_reason_native, session_end_reason_normalized FROM conversations WHERE session_id = ?",
      )
      .get(SESSION) as Record<string, unknown> | undefined;

    expect(row?.session_end_reason_native).toBe("prompt_input_exit");
    expect(row?.session_end_reason_normalized).toBe("user_exit");
  });
});

test("a session.end with no native reason records the catch-all normalized reason and a NULL native reason", () => {
  withStore((store) => {
    store.insertEvent(
      sessionEvent("session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent(
      sessionEvent("session.end", "2026-05-21T12:34:56.000Z", {
        end_reason_normalized: "other",
      }),
    );

    const row = store.db
      .prepare(
        "SELECT session_end_reason_native, session_end_reason_normalized FROM conversations WHERE session_id = ?",
      )
      .get(SESSION) as Record<string, unknown> | undefined;

    expect(row?.session_end_reason_native).toBeNull();
    expect(row?.session_end_reason_normalized).toBe("other");
  });
});

test("a deliberate exit is distinguishable from an abrupt ending on the conversations row", () => {
  withStore((store) => {
    store.insertEvent(
      sessionEvent("session.start", "2026-05-21T12:00:00.000Z"),
    );
    store.insertEvent(
      sessionEvent("session.end", "2026-05-21T12:34:56.000Z", {
        end_reason_native: "prompt_input_exit",
        end_reason_normalized: "user_exit",
      }),
    );

    const reason = (
      store.db
        .prepare(
          "SELECT session_end_reason_normalized FROM conversations WHERE session_id = ?",
        )
        .get(SESSION) as Record<string, unknown>
    ).session_end_reason_normalized;

    expect(reason).not.toBe("aborted");
    expect(reason).toBe("user_exit");
  });
});

test("session.start writes a conversations row with session_started_at and a NULL ended_at", () => {
  withStore((store) => {
    const startedAt = "2026-05-21T12:00:00.000Z";
    store.insertEvent(sessionEvent("session.start", startedAt));

    const row = store.db
      .prepare(
        "SELECT session_id, harness, model, session_started_at, session_ended_at, first_event_at, last_event_at FROM conversations WHERE session_id = ?",
      )
      .get(SESSION) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row?.session_id).toBe(SESSION);
    expect(row?.harness).toBe("claude");
    expect(row?.model).toBe("claude-opus-4-7");
    expect(row?.session_started_at).toBe(startedAt);
    expect(row?.session_ended_at).toBeNull();
    expect(row?.first_event_at).toBe(startedAt);
    expect(row?.last_event_at).toBe(startedAt);
  });
});
