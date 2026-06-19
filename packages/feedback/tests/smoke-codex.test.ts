/**
 * Real-shape smoke test for the Codex capture path.
 *
 * The sample envelopes follow the validated Codex hook payload shapes
 * (developers.openai.com/codex/hooks) and are sanitized the same way as the
 * Claude fixture: tool_input, tool_response, cwd, and transcript_path are
 * redacted, session_id is a stable placeholder, and each PreToolUse/PostToolUse
 * pair shares a unique anonymized tool_use_id (the projection's pairing key).
 * The fields the translator reads are intact, so this exercises the dispatch,
 * translator, store, and projection path against shapes the Codex hook really
 * produces.
 *
 * It also pins two honest Codex divergences from Claude: Codex has no
 * session-end hook, so the conversation's session_ended_at stays NULL, and
 * Codex edits run through apply_patch rather than an Edit/Write tool exposing
 * file_path, so no per-file churn is recorded from the hook payload.
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

const FIXTURE = join(import.meta.dir, "..", "samples", "codex-envelopes.jsonl");

function fixtureLines(): string[] {
  return readFileSync(FIXTURE, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

test("signal tables reflect the Codex fixture: one conversation with no end, paired tool spans, no churn", () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-smoke-codex-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    for (const line of fixtureLines()) {
      const result = dispatchLine(line);
      if (result.kind === "event") store.insertEvent(result.event);
    }

    const conversation = store.db
      .prepare(
        "SELECT session_id, harness, model, cwd, session_started_at, session_ended_at FROM conversations",
      )
      .all() as ReadonlyArray<Record<string, unknown>>;
    expect(conversation.length).toBe(1);
    expect(conversation[0]?.session_id).toBe("codex-sample-session");
    expect(conversation[0]?.harness).toBe("codex");
    expect(conversation[0]?.model).toBe("gpt-5.5");
    expect(conversation[0]?.cwd).toBe("<redacted>");
    expect(conversation[0]?.session_started_at).not.toBeNull();
    // Codex has no session-end hook, so this boundary is never set from hooks.
    expect(conversation[0]?.session_ended_at).toBeNull();

    const total = (
      store.db.prepare("SELECT COUNT(*) AS n FROM tool_call_spans").get() as {
        n: number;
      }
    ).n;
    const paired = (
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tool_call_spans WHERE ended_at IS NOT NULL AND duration_ms IS NOT NULL",
        )
        .get() as { n: number }
    ).n;
    expect(total).toBe(3);
    expect(paired).toBe(3);

    const churn = (
      store.db
        .prepare("SELECT COUNT(*) AS n FROM repeated_file_edits")
        .get() as { n: number }
    ).n;
    expect(churn).toBe(0);

    const counts = store.db
      .prepare(
        "SELECT prompt_count, tool_call_count, compaction_count, gate_denial_count FROM conversation_counts WHERE session_id = ?",
      )
      .get("codex-sample-session") as Record<string, unknown>;
    expect(counts.prompt_count).toBe(1);
    expect(counts.tool_call_count).toBe(3);
    expect(counts.compaction_count).toBe(1);
    expect(counts.gate_denial_count).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every Codex fixture envelope dispatches without quarantine, and every event is schema-valid", () => {
  const lines = fixtureLines();
  expect(lines.length).toBeGreaterThan(0);

  let events = 0;
  for (const line of lines) {
    const result = dispatchLine(line);
    if (result.kind === "quarantine") {
      throw new Error(`unexpected quarantine: ${result.reason}\nline: ${line}`);
    }
    if (result.kind === "skip") continue;
    events += 1;
    validate(result.event);
    expect(
      validate.errors ?? [],
      `${result.event.event_type} ${result.event.attributes.tool_name ?? ""}`,
    ).toEqual([]);
  }
  expect(events).toBe(lines.length);
});
