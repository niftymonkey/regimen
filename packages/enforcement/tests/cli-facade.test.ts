/**
 * The Enforcement facade called IN-PROCESS as library functions taking
 * already-parsed options, the shape the unified `regimen` CLI dispatches to
 * (ADR-0012). With no shipped gate catalog (author-on-demand), `install`/
 * `uninstall` lay down and remove the lever's operator skill; the authored-gate
 * wiring path survives as the library functions `wireAuthoredGate`/
 * `unwireAuthoredGates` the `enforcement-respond` skill calls at authoring time.
 * The harness and config home travel in the environment (REGIMEN_HARNESS and the
 * contract's config-home env var), so each test sets a temp config home and
 * scrubs ambient markers before calling.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthoredGate,
  install,
  installSkill,
  uninstall,
  uninstallSkill,
  unwireAuthoredGates,
  wireAuthoredGate,
} from "../src/cli/index.ts";

const MARKERS = ["CLAUDECODE", "CODEX_THREAD_ID", "GEMINI_CLI", "COPILOT_CLI"];

const RM_RF: AuthoredGate = {
  id: "rm-rf",
  scriptPath: "tests/fixtures/rm-rf-gate.ts",
};

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

const SKILL = join("skills", "enforcement-respond", "SKILL.md");

test("install lays down the operator skill and wires NO gates", () => {
  withCodexHome((codexHome) => {
    const exit = install({ dryRun: false });
    expect(exit).toBe(0);
    // The skill landed where the harness discovers it.
    expect(existsSync(join(codexHome, SKILL))).toBe(true);
    // Install never writes a hooks file: it ships no catalog of gates.
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("install installs the enforcement-respond skill, not a feedback skill", () => {
  withCodexHome((codexHome) => {
    install({ dryRun: false });
    const content = readFileSync(join(codexHome, SKILL), "utf8");
    expect(content).toContain("name: enforcement-respond");
    expect(existsSync(join(codexHome, "skills", "feedback-evidence"))).toBe(
      false,
    );
  });
});

test("install --dry-run previews the skill target and writes nothing", () => {
  withCodexHome((codexHome) => {
    let exit = 1;
    const out = captureStdout(() => {
      exit = install({ dryRun: true });
    });
    expect(exit).toBe(0);
    expect(out).toContain("enforcement-respond");
    expect(out).toContain("nothing was changed");
    expect(existsSync(join(codexHome, SKILL))).toBe(false);
  });
});

test("uninstall removes the operator skill", () => {
  withCodexHome((codexHome) => {
    installSkill({ dryRun: false });
    expect(existsSync(join(codexHome, SKILL))).toBe(true);
    const exit = uninstall({ dryRun: false });
    expect(exit).toBe(0);
    expect(existsSync(join(codexHome, "skills", "enforcement-respond"))).toBe(
      false,
    );
  });
});

test("uninstallSkill on a missing skill is a clean no-op", () => {
  withCodexHome(() => {
    const exit = uninstallSkill({ dryRun: false });
    expect(exit).toBe(0);
  });
});

test("wireAuthoredGate merges an authored gate onto the harness pre-tool event", () => {
  withCodexHome((codexHome) => {
    const exit = wireAuthoredGate({ gate: RM_RF, dryRun: false });
    expect(exit).toBe(0);
    expect(gateIds(codexHome)).toEqual(["rm-rf"]);
  });
});

test("unwireAuthoredGates removes the gate it wired", () => {
  withCodexHome((codexHome) => {
    wireAuthoredGate({ gate: RM_RF, dryRun: false });
    const exit = unwireAuthoredGates({ dryRun: false });
    expect(exit).toBe(0);
    expect(gateIds(codexHome)).toEqual([]);
  });
});

test("wireAuthoredGate --dry-run previews and writes nothing", () => {
  withCodexHome((codexHome) => {
    let exit = 1;
    const out = captureStdout(() => {
      exit = wireAuthoredGate({ gate: RM_RF, dryRun: true });
    });
    expect(exit).toBe(0);
    expect(out).toContain("would wire gate rm-rf on PreToolUse");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});
