/**
 * Real-shape smoke test for the Codex rollout reader through the store and
 * the deterministic signal projections.
 *
 * `rollout-codex-session.jsonl` is a real, comprehensive `codex exec` session
 * (codex-cli 0.128.0, gpt-5.5) captured to disk across two turns, then
 * redacted: base_instructions, cwd, git, and the model's prose are replaced
 * with placeholders, while the fields the reader reads (line types, call_ids,
 * the apply_patch patch text, web-search queries, timestamps, the turn model)
 * are intact. Over two prompts the agent ran two web searches, two shell
 * commands, and three apply_patch edits of findings.md, so the one transcript
 * exercises the full mapped surface end to end.
 *
 * It pins what 1.4 adds over the hook path: the session.end boundary hooks
 * cannot give (emitted only when the transcript is complete), tool spans
 * paired by call_id, per-file churn read from the apply_patch patch text (this
 * build emits no patch_apply_end at all), and web searches captured as tool
 * spans even though they carry no call_id.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { rolloutEvents } from "../src/loader/rollout/codex-reader.ts";
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

const SAMPLES = join(import.meta.dir, "..", "samples");
const REAL_SESSION = "019e8c20-4491-7ea3-b809-d6586a5a72b8";
const SHELL_SESSION = "019e0000-1111-7000-8000-000000000001";

function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

function withStore(fn: (store: ReturnType<typeof openStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-smoke-rollout-"));
  const store = openStore(join(dir, "feedback.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the real comprehensive rollout yields an ended two-prompt conversation with web-search, shell, and apply_patch spans plus findings.md churn", () => {
  withStore((store) => {
    for (const event of rolloutEvents(fixture("rollout-codex-session.jsonl"), {
      complete: true,
    })) {
      store.insertEvent(event);
    }

    const conversation = store.db
      .prepare(
        "SELECT harness, model, cwd, session_started_at, session_ended_at, session_end_reason_native, session_end_reason_normalized FROM conversations WHERE session_id = ?",
      )
      .get(REAL_SESSION) as Record<string, unknown>;
    expect(conversation.harness).toBe("codex");
    expect(conversation.model).toBe("gpt-5.5");
    // The working directory comes from session_meta, threaded across the fold.
    expect(conversation.cwd).toBe("/work/scratch");
    expect(conversation.session_started_at).not.toBeNull();
    // The boundary hooks cannot give: a complete transcript ends honestly.
    expect(conversation.session_ended_at).not.toBeNull();
    // Codex exposes no native end reason, so it records the catch-all.
    expect(conversation.session_end_reason_native).toBeNull();
    expect(conversation.session_end_reason_normalized).toBe("other");

    const spans = store.db
      .prepare(
        "SELECT tool_name, ended_at FROM tool_call_spans WHERE session_id = ?",
      )
      .all(REAL_SESSION) as ReadonlyArray<Record<string, unknown>>;
    // 2 exec_command + 3 apply_patch + 2 web_search, each paired.
    expect(spans.length).toBe(7);
    expect(spans.every((s) => s.ended_at !== null)).toBe(true);
    const byTool = (name: string): number =>
      spans.filter((s) => s.tool_name === name).length;
    expect(byTool("exec_command")).toBe(2);
    expect(byTool("apply_patch")).toBe(3);
    expect(byTool("web_search")).toBe(2);

    const churn = store.db
      .prepare(
        "SELECT file_path, edit_count FROM repeated_file_edits WHERE session_id = ?",
      )
      .all(REAL_SESSION) as ReadonlyArray<Record<string, unknown>>;
    // findings.md was created then edited twice: three apply_patch touches.
    expect(churn.length).toBe(1);
    expect(churn[0]?.file_path).toBe("findings.md");
    expect(churn[0]?.edit_count).toBe(3);

    const counts = store.db
      .prepare(
        "SELECT prompt_count, tool_call_count, compaction_count FROM conversation_counts WHERE session_id = ?",
      )
      .get(REAL_SESSION) as Record<string, unknown>;
    expect(counts.prompt_count).toBe(2);
    expect(counts.tool_call_count).toBe(7);
    expect(counts.compaction_count).toBe(0);
  });
});

test("an incomplete rollout leaves the conversation open, never force-closed", () => {
  withStore((store) => {
    for (const event of rolloutEvents(fixture("rollout-shell-session.jsonl"), {
      complete: false,
    })) {
      store.insertEvent(event);
    }

    const conversation = store.db
      .prepare(
        "SELECT session_started_at, session_ended_at FROM conversations WHERE session_id = ?",
      )
      .get(SHELL_SESSION) as Record<string, unknown>;
    expect(conversation.session_started_at).not.toBeNull();
    expect(conversation.session_ended_at).toBeNull();
  });
});

test("every event a rollout fixture yields is schema-valid", () => {
  for (const name of [
    "rollout-shell-session.jsonl",
    "rollout-codex-session.jsonl",
  ]) {
    const events = rolloutEvents(fixture(name), { complete: true });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      validate(event);
      expect(validate.errors ?? [], `${name} ${event.event_type}`).toEqual([]);
    }
  }
});
