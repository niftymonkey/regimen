/**
 * Real-payload smoke test for the Claude capture path.
 *
 * Sample envelopes were captured from a live Claude Code session and then
 * sanitized: tool_input, tool_response, cwd, and transcript_path are
 * redacted, session_id is replaced with a stable placeholder, and every
 * `tool_use_id` is rewritten so each PreToolUse/PostToolUse pair shares a
 * unique anonymized id (the projection's pairing key). The fields the
 * translator actually reads are kept intact, so this test exercises the
 * dispatch, translator, and projection path against shapes the hook really
 * produces, including fields synthetic fixtures do not cover
 * (`permission_mode`, `effort`, `duration_ms`).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { dispatchLine } from "../src/loader/translators/index.ts";
import { openStore } from "../src/store.ts";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

const FIXTURE = join(
  import.meta.dir,
  "..",
  "samples",
  "claude-envelopes.jsonl",
);

test("signal tables reflect the Claude fixture: one conversation, paired tool spans, no torn rows", () => {
  const lines = readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const dir = mkdtempSync(join(tmpdir(), "regimen-smoke-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    for (const line of lines) {
      const result = dispatchLine(line);
      if (result.kind === "event") store.insertEvent(result.event);
    }

    const conversation = store.db
      .prepare(
        "SELECT session_id, cwd, session_started_at, session_ended_at, session_end_reason_native, session_end_reason_normalized FROM conversations",
      )
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(conversation.length).toBe(1);
    expect(conversation[0]?.session_id).toBe("claude-sample-session");
    expect(conversation[0]?.cwd).toBe("<redacted>");
    expect(conversation[0]?.session_started_at).not.toBeNull();
    expect(conversation[0]?.session_ended_at).not.toBeNull();
    // The real capture ended on /exit (reason: prompt_input_exit), so the
    // store records both the native reason and its normalized value without
    // a reader re-deriving them from raw events.
    expect(conversation[0]?.session_end_reason_native).toBe(
      "prompt_input_exit",
    );
    expect(conversation[0]?.session_end_reason_normalized).toBe("user_exit");

    const paired = (
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tool_call_spans WHERE ended_at IS NOT NULL AND duration_ms IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
    const total = (
      store.db.prepare("SELECT COUNT(*) AS n FROM tool_call_spans").get() as {
        n: number;
      }
    ).n;
    expect(total).toBe(15);
    expect(paired).toBe(15);

    const counts = store.db
      .prepare(
        "SELECT prompt_count, tool_call_count, compaction_count FROM conversation_counts WHERE session_id = ?",
      )
      .get("claude-sample-session") as Record<string, unknown>;
    expect(counts.prompt_count).toBe(1);
    expect(counts.tool_call_count).toBe(15);
    expect(counts.compaction_count).toBe(1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every real-captured Claude envelope dispatches without quarantine, and every event is schema-valid", () => {
  const lines = readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThan(0);

  let events = 0;
  let skips = 0;
  for (const line of lines) {
    const result = dispatchLine(line);
    if (result.kind === "quarantine") {
      throw new Error(`unexpected quarantine: ${result.reason}\nline: ${line}`);
    }
    if (result.kind === "skip") {
      skips += 1;
      continue;
    }
    events += 1;
    validate(result.event);
    expect(
      validate.errors ?? [],
      `${result.event.event_type} ${result.event.attributes.tool_name ?? ""}`,
    ).toEqual([]);
  }
  expect(events).toBeGreaterThan(0);
  // Skips are acceptable: harness events with no v1 mapping yet (e.g. Stop,
  // SubagentStop, Notification, PostCompact). The buffer still preserves
  // them as envelopes; only the v1 projection is empty.
  expect(skips).toBeGreaterThanOrEqual(0);
});
