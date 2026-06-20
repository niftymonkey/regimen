/**
 * The store-write seam, exercised as an EXTERNAL producer would: no Feedback
 * imports, the v1 gate.denial line built from raw primitives, and the trace_id
 * asserted against the literal value the published contract's worked example
 * gives (regimen-feedback/docs/store-write-contract.md). If Feedback ever
 * changes the frozen derivation, this fails loudly and the contract must be
 * revised rather than silently orphaning Enforcement's events.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  appendGateDenial,
  buildGateDenialLine,
  resolveDataDir,
} from "../src/denial-store.ts";

test("buildGateDenialLine matches the contract worked example, byte for byte", () => {
  const event = buildGateDenialLine({
    gate_id: "rm-rf-guard",
    session_id: "claude-session-9f3a",
    harness: "claude",
    tool_name: "Bash",
    tool_call_id: "toolu_rm01",
    reason: "recursive forced rm denied",
  });

  // The frozen trace_id from the contract's worked example.
  expect(event.trace_id).toBe("7e2338f03062a008a2f9a90e125d7ec9");
  expect(event.schema_version).toBe(1);
  expect(event.session_id).toBe("claude-session-9f3a");
  expect(event.harness).toBe("claude");
  expect(event.event_type).toBe("gate.denial");
  expect(event.span_phase).toBe("point");
  expect(event.span_name).toBe("gate:rm-rf-guard");
  expect(event.attributes).toEqual({
    gate_id: "rm-rf-guard",
    tool_name: "Bash",
    tool_call_id: "toolu_rm01",
    reason: "recursive forced rm denied",
  });
  // timestamp is ISO 8601 UTC.
  expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("buildGateDenialLine omits model and reason when they are absent", () => {
  const event = buildGateDenialLine({
    gate_id: "rm-rf-guard",
    session_id: "s1",
    harness: "codex",
    tool_name: "Bash",
    tool_call_id: "call_1",
  });
  expect("model" in event).toBe(false);
  expect("reason" in event.attributes).toBe(false);
});

test("appendGateDenial mkdir -ps the buffer and writes one newline-terminated line", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-enforce-store-"));
  try {
    const event = buildGateDenialLine({
      gate_id: "rm-rf-guard",
      session_id: "claude-session-9f3a",
      harness: "claude",
      tool_name: "Bash",
      tool_call_id: "toolu_rm01",
      reason: "recursive forced rm denied",
    });
    appendGateDenial(dataDir, event);

    const raw = readFileSync(join(dataDir, "buffer", "current.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(event);

    // A second append adds a second line, never rewriting the first.
    appendGateDenial(dataDir, event);
    const after = readFileSync(
      join(dataDir, "buffer", "current.jsonl"),
      "utf8",
    );
    expect(after.trim().split("\n")).toHaveLength(2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("resolveDataDir honors REGIMEN_DATA_DIR on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    expect(
      resolveDataDir({ REGIMEN_DATA_DIR: "/tmp/override" }, platform),
    ).toBe("/tmp/override");
  }
});

test("resolveDataDir dispatches per OS to the same dir Feedback reads", () => {
  expect(
    resolveDataDir({ XDG_DATA_HOME: "/xdg", HOME: "/home/me" }, "linux"),
  ).toBe(posix.join("/xdg", "regimen"));
  expect(resolveDataDir({ HOME: "/home/me" }, "linux")).toBe(
    posix.join("/home/me", ".local", "share", "regimen"),
  );
  expect(resolveDataDir({ HOME: "/Users/me" }, "darwin")).toBe(
    posix.join("/Users/me", "Library", "Application Support", "regimen"),
  );
  expect(
    resolveDataDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32"),
  ).toBe(win32.join("C:\\Users\\me\\AppData\\Roaming", "regimen"));
});

test("resolveDataDir throws when nothing resolves", () => {
  expect(() => resolveDataDir({}, "linux")).toThrow(/REGIMEN_DATA_DIR/);
  expect(() => resolveDataDir({}, "sunos")).toThrow(/REGIMEN_DATA_DIR/);
});
