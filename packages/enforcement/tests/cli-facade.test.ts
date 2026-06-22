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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Run `fn`, returning everything it wrote to stdout. */
function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
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

test("install on win32 skips gates, prints a notice, returns 0, writes nothing", () => {
  withCodexHome((codexHome) => {
    let exit = 1;
    const out = captureStdout(() => {
      exit = install({
        gates: ["rm-rf", "em-dash", "inline-message"],
        dryRun: false,
        platform: "win32",
      });
    });
    expect(exit).toBe(0);
    expect(out).toContain("not yet supported on native Windows");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("install on win32 skips even with dryRun set", () => {
  withCodexHome((codexHome) => {
    let exit = 1;
    const out = captureStdout(() => {
      exit = install({
        gates: ["rm-rf", "em-dash", "inline-message"],
        dryRun: true,
        platform: "win32",
      });
    });
    expect(exit).toBe(0);
    expect(out).toContain("not yet supported on native Windows");
    expect(out).not.toContain("would wire");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("uninstall on win32 skips teardown, prints a notice, returns 0, touches nothing", () => {
  withCodexHome((codexHome) => {
    install({
      gates: ["rm-rf", "em-dash", "inline-message"],
      dryRun: false,
    });
    const before = readFileSync(join(codexHome, "hooks.json"), "utf8");
    let exit = 1;
    const out = captureStdout(() => {
      exit = uninstall({ dryRun: false, platform: "win32" });
    });
    expect(exit).toBe(0);
    expect(out).toContain("not yet supported on native Windows");
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toBe(before);
    expect(gateIds(codexHome)).toEqual(["rm-rf", "em-dash", "inline-message"]);
  });
});
