import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEnvelope } from "../hooks/event-log.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-buffer-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("appendEnvelope writes one envelope line to current.jsonl", () => {
  withTempDir((dir) => {
    appendEnvelope("claude", { hook_event_name: "SessionStart" }, dir);
    const contents = readFileSync(join(dir, "current.jsonl"), "utf8");
    const lines = contents.trim().split("\n");
    expect(lines.length).toBe(1);
    const envelope = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(envelope.harness).toBe("claude");
    expect(envelope.payload).toEqual({ hook_event_name: "SessionStart" });
    expect(typeof envelope.captured_at).toBe("string");
    expect((envelope.captured_at as string).length).toBeGreaterThan(0);
  });
});

test("appendEnvelope appends rather than overwriting on subsequent calls", () => {
  withTempDir((dir) => {
    appendEnvelope("claude", { hook_event_name: "SessionStart" }, dir);
    appendEnvelope("claude", { hook_event_name: "UserPromptSubmit" }, dir);
    const lines = readFileSync(join(dir, "current.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0] ?? "") as {
      payload: { hook_event_name: string };
    };
    const second = JSON.parse(lines[1] ?? "") as {
      payload: { hook_event_name: string };
    };
    expect(first.payload.hook_event_name).toBe("SessionStart");
    expect(second.payload.hook_event_name).toBe("UserPromptSubmit");
  });
});

test("appendEnvelope creates the buffer directory if it does not exist", () => {
  withTempDir((parent) => {
    const dir = join(parent, "nested", "buffer");
    appendEnvelope("claude", { hook_event_name: "SessionStart" }, dir);
    const contents = readFileSync(join(dir, "current.jsonl"), "utf8");
    expect(contents.trim().split("\n").length).toBe(1);
  });
});
