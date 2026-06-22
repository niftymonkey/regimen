/**
 * The wire-gates / unwire-gates / install / uninstall commands called
 * IN-PROCESS as library functions taking already-parsed options, the shape the
 * unified `regimen` CLI dispatches to (ADR-0012). The subprocess argv path is
 * covered by cli.test.ts; here we confirm each command is directly callable with
 * a typed options object and produces the same exit-code / stdout contract. The
 * harness and config home still travel in the environment (REGIMEN_HARNESS and
 * the contract's config-home env var), so each test sets a temp config home and
 * scrubs ambient markers before calling.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install,
  uninstall,
  unwireGates,
  wireGates,
} from "../src/cli/index.ts";

const MARKERS = ["CLAUDECODE", "CODEX_THREAD_ID", "GEMINI_CLI", "COPILOT_CLI"];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of [...MARKERS, "REGIMEN_HARNESS", "CODEX_HOME"]) {
    saved[key] = process.env[key];
  }
  for (const key of MARKERS) delete process.env[key];
  process.env.REGIMEN_HARNESS = "codex";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withCodexHome(fn: (codexHome: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-facade-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    fn(dir);
  } finally {
    process.env.CODEX_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Leaf {
  command: string;
  _regimen?: { v: number; role: string; id?: string };
}

function gateIds(codexHome: string): Array<string | undefined> {
  const parsed = JSON.parse(
    readFileSync(join(codexHome, "hooks.json"), "utf8"),
  ) as { hooks?: { PreToolUse?: Array<{ hooks: Leaf[] }> } };
  return (parsed.hooks?.PreToolUse ?? [])
    .flatMap((g) => g.hooks)
    .filter((l) => l._regimen?.role === "gate")
    .map((l) => l._regimen?.id);
}

test("wireGates writes the default three gates and returns 0", () => {
  withCodexHome((codexHome) => {
    const exit = wireGates({
      gates: ["rm-rf", "em-dash", "inline-message"],
      dryRun: false,
    });
    expect(exit).toBe(0);
    expect(gateIds(codexHome)).toEqual(["rm-rf", "em-dash", "inline-message"]);
  });
});

test("unwireGates removes the gates it wired and returns 0", () => {
  withCodexHome((codexHome) => {
    wireGates({
      gates: ["rm-rf", "em-dash", "inline-message"],
      dryRun: false,
    });
    const exit = unwireGates({ dryRun: false });
    expect(exit).toBe(0);
    expect(gateIds(codexHome)).toEqual([]);
  });
});

test("install wires the gates and returns 0", () => {
  withCodexHome((codexHome) => {
    const exit = install({
      gates: ["rm-rf", "em-dash", "inline-message"],
      dryRun: false,
    });
    expect(exit).toBe(0);
    expect(gateIds(codexHome)).toEqual(["rm-rf", "em-dash", "inline-message"]);
  });
});

test("uninstall removes the gates and returns 0", () => {
  withCodexHome((codexHome) => {
    install({
      gates: ["rm-rf", "em-dash", "inline-message"],
      dryRun: false,
    });
    const exit = uninstall({ dryRun: false });
    expect(exit).toBe(0);
    expect(gateIds(codexHome)).toEqual([]);
  });
});
