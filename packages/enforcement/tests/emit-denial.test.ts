/**
 * The gate-denial emitter CLI, spawned as a gate would invoke it, against a temp
 * REGIMEN_DATA_DIR. The recorded line is validated against the event schema (a
 * fixture copy, never an import from Feedback). Mirrors Feedback's
 * emit-denial.test.ts but for Enforcement's own reimplemented emitter.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SCHEMA: object = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "event.schema.json"), "utf8"),
);
const EMITTER = join(import.meta.dir, "..", "hooks", "emit-denial.ts");
const SESSION = "claude-test-denial-5b2c";

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

/** Parse the buffer's current segment into objects, in order. */
function readEvents(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, "buffer", "current.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line));
}

/** The single logged event, asserting exactly one was recorded. */
function onlyEvent(dir: string): Record<string, unknown> {
  const events = readEvents(dir);
  expect(events.length).toBe(1);
  const event = events[0];
  if (event === undefined) throw new Error("expected one logged event");
  return event;
}

test("the emitter appends a schema-valid gate.denial to the buffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        EMITTER,
        "--gate",
        "rm-rf-guard",
        "--session",
        SESSION,
        "--harness",
        "claude",
        "--tool",
        "Bash",
        "--tool-call-id",
        "toolu_rm01",
        "--reason",
        "recursive forced rm denied",
      ],
      { env: { ...process.env, REGIMEN_DATA_DIR: dir }, stdout: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");

    const event = onlyEvent(dir);
    validate(event);
    expect(validate.errors ?? []).toEqual([]);
    expect(event.event_type).toBe("gate.denial");
    expect(event.span_phase).toBe("point");
    expect(event.attributes).toMatchObject({
      gate_id: "rm-rf-guard",
      tool_name: "Bash",
      tool_call_id: "toolu_rm01",
      reason: "recursive forced rm denied",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--from-hook fills session, tool, tool-call-id, and model from the PreToolUse payload on stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      tool_use_id: "toolu_hd01",
      tool_input: { command: "git commit -m x" },
      model: "claude-opus-4-8",
    };
    const proc = Bun.spawn(
      [
        "bun",
        EMITTER,
        "--from-hook",
        "--gate",
        "inline-message-guard",
        "--harness",
        "claude",
        "--reason",
        "use -m or --body-file",
      ],
      {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        env: { ...process.env, REGIMEN_DATA_DIR: dir },
        stdout: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");

    const event = onlyEvent(dir);
    validate(event);
    expect(validate.errors ?? []).toEqual([]);
    expect(event.event_type).toBe("gate.denial");
    expect(event.model).toBe("claude-opus-4-8");
    expect(event.attributes).toMatchObject({
      gate_id: "inline-message-guard",
      tool_name: "Bash",
      tool_call_id: "toolu_hd01",
      reason: "use -m or --body-file",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit flag overrides the same field on the hook payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const payload = {
      session_id: "payload-session",
      tool_name: "Edit",
      tool_use_id: "payload-call",
    };
    const proc = Bun.spawn(
      [
        "bun",
        EMITTER,
        "--from-hook",
        "--gate",
        "rm-rf-guard",
        "--harness",
        "claude",
        "--session",
        "explicit-session",
        "--tool",
        "Bash",
        "--tool-call-id",
        "explicit-call",
      ],
      {
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        env: { ...process.env, REGIMEN_DATA_DIR: dir },
        stdout: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);

    const event = onlyEvent(dir);
    expect(event.session_id).toBe("explicit-session");
    expect(event.attributes).toMatchObject({
      tool_name: "Bash",
      tool_call_id: "explicit-call",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the emitter fails safe when a required flag is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const proc = Bun.spawn(["bun", EMITTER, "--gate", "incomplete"], {
      env: { ...process.env, REGIMEN_DATA_DIR: dir },
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the emitter fails safe when a required flag is an empty string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        EMITTER,
        "--gate",
        "rm-rf-guard",
        "--session",
        "",
        "--harness",
        "claude",
        "--tool",
        "Bash",
        "--tool-call-id",
        "toolu_rm01",
      ],
      { env: { ...process.env, REGIMEN_DATA_DIR: dir }, stdout: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("");
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the emitter fails safe on an unknown harness value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        EMITTER,
        "--gate",
        "rm-rf-guard",
        "--session",
        SESSION,
        "--harness",
        "not-a-harness",
        "--tool",
        "Bash",
        "--tool-call-id",
        "toolu_rm01",
      ],
      { env: { ...process.env, REGIMEN_DATA_DIR: dir }, stdout: "pipe" },
    );
    expect(await proc.exited).toBe(0);
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--from-hook fails safe when the hook payload on stdin is malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        EMITTER,
        "--from-hook",
        "--gate",
        "inline-message-guard",
        "--harness",
        "claude",
        "--reason",
        "use -m or --body-file",
      ],
      {
        stdin: new TextEncoder().encode("not valid json"),
        env: { ...process.env, REGIMEN_DATA_DIR: dir },
        stdout: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    expect(readEvents(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
