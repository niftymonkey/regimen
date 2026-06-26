/**
 * The Guidance facade called IN-PROCESS as library functions taking
 * already-parsed options, the shape the unified `regimen` CLI dispatches to
 * (ADR-0012). Guidance is the thinnest lever: `install`/`uninstall` lay down and
 * remove the lever's operator skill, and there is no gate-wiring path. The harness
 * and config home travel in the environment (REGIMEN_HARNESS and the contract's
 * config-home env var), so each test sets a temp config home and scrubs ambient
 * markers before calling.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install,
  installSkill,
  uninstall,
  uninstallSkill,
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
  const dir = mkdtempSync(join(tmpdir(), "regimen-guidance-facade-"));
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

const SKILL = join("skills", "guidance-respond", "SKILL.md");

test("install lays down the operator skill and wires NO gates", () => {
  withCodexHome((codexHome) => {
    const exit = install({ dryRun: false });
    expect(exit).toBe(0);
    // The skill landed where the harness discovers it.
    expect(existsSync(join(codexHome, SKILL))).toBe(true);
    // Install never writes a hooks file: Guidance wires no gates.
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("install installs the guidance-respond skill, not a feedback skill", () => {
  withCodexHome((codexHome) => {
    install({ dryRun: false });
    const content = readFileSync(join(codexHome, SKILL), "utf8");
    expect(content).toContain("name: guidance-respond");
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
    expect(out).toContain("guidance-respond");
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
    expect(existsSync(join(codexHome, "skills", "guidance-respond"))).toBe(
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

test("uninstallSkill is best-effort: a removal failure is recorded, not thrown", () => {
  withCodexHome((codexHome) => {
    installSkill({ dryRun: false });
    const skillsDir = join(codexHome, "skills");
    // Make the skills directory non-writable so removing the skill subdirectory
    // under it fails (EACCES), the realistic IO failure the loop must survive.
    chmodSync(skillsDir, 0o500);
    try {
      const exit = uninstallSkill({ dryRun: false });
      // Best-effort: the failure is reported through the exit code, never thrown.
      expect(exit).not.toBe(0);
    } finally {
      chmodSync(skillsDir, 0o700);
    }
  });
});
