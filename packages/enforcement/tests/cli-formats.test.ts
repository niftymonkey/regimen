/**
 * The authored-gate wiring across the two divergent harness install shapes,
 * driven in-process against the exported library functions (ADR-0012). Copilot
 * writes the `versioned-command-leaves` file at `$COPILOT_HOME/hooks/hooks.json`
 * (flat leaves under a top-level `version`, on `preToolUse`). Gemini installs
 * PROJECT-level: the gate lands in `<cwd>/.gemini/settings.json` (named+matched
 * nested group on `BeforeTool`), not in the config home, because only a
 * project-level settings file fires headless (ADR-0011,
 * docs/harness-divergences.md). The pure merge is covered by
 * gate-hooks-formats.test.ts; here we cover that wiring an authored gate writes
 * the right file at the right path with the right shape, and removes it cleanly.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthoredGate,
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
  for (const key of [
    ...MARKERS,
    "REGIMEN_HARNESS",
    "COPILOT_HOME",
    "GEMINI_CONFIG_DIR",
  ]) {
    saved[key] = process.env[key];
  }
  for (const key of MARKERS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-fmt-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `fn` chdir'd into `cwd` (the gemini project-level install reads process.cwd()). */
function inCwd(cwd: string, fn: () => void): void {
  const savedCwd = process.cwd();
  process.chdir(cwd);
  try {
    fn();
  } finally {
    process.chdir(savedCwd);
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
  type: string;
  command: string;
  _regimen?: { v: number; role: string; id?: string };
}

test("copilot: wireAuthoredGate writes a versioned flat gate leaf at hooks/hooks.json", () => {
  withTempDir((copilotHome) => {
    process.env.REGIMEN_HARNESS = "copilot";
    process.env.COPILOT_HOME = copilotHome;
    const exit = wireAuthoredGate({ gate: RM_RF, dryRun: false });
    expect(exit).toBe(0);

    const parsed = JSON.parse(
      readFileSync(join(copilotHome, "hooks", "hooks.json"), "utf8"),
    ) as { version?: number; hooks?: Record<string, Leaf[]> };
    expect(parsed.version).toBe(1);
    const leaves = parsed.hooks?.preToolUse ?? [];
    // Flat leaf, no matcher-group wrapper, marked role:gate, baked for copilot.
    const ids = leaves
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l._regimen?.id);
    expect(ids).toEqual(["rm-rf"]);
    for (const leaf of leaves) {
      expect((leaf as { hooks?: unknown }).hooks).toBeUndefined();
      expect(leaf.command).toContain("REGIMEN_HARNESS=copilot");
    }
    expect(parsed.hooks?.PreToolUse).toBeUndefined();
  });
});

test("copilot: unwireAuthoredGates removes the versioned gate leaf cleanly", () => {
  withTempDir((copilotHome) => {
    process.env.REGIMEN_HARNESS = "copilot";
    process.env.COPILOT_HOME = copilotHome;
    wireAuthoredGate({ gate: RM_RF, dryRun: false });
    let stdout = "";
    const exit = (() => {
      let code = 1;
      stdout = captureStdout(() => {
        code = unwireAuthoredGates({ dryRun: false });
      });
      return code;
    })();
    expect(exit).toBe(0);
    expect(stdout).toContain("removed gate rm-rf on preToolUse");

    const parsed = JSON.parse(
      readFileSync(join(copilotHome, "hooks", "hooks.json"), "utf8"),
    ) as { hooks?: Record<string, Leaf[]> };
    const leaves = parsed.hooks?.preToolUse ?? [];
    expect(leaves.some((l) => l._regimen?.role === "gate")).toBe(false);
  });
});

test("gemini: wireAuthoredGate installs project-level at <cwd>/.gemini/settings.json with name+matcher on BeforeTool", () => {
  withTempDir((workdir) => {
    process.env.REGIMEN_HARNESS = "gemini";
    process.env.GEMINI_CONFIG_DIR = join(workdir, "config");
    inCwd(workdir, () => {
      const exit = wireAuthoredGate({ gate: RM_RF, dryRun: false });
      expect(exit).toBe(0);
    });

    const parsed = JSON.parse(
      readFileSync(join(workdir, ".gemini", "settings.json"), "utf8"),
    ) as {
      hooks?: Record<
        string,
        Array<{ name?: string; matcher?: string; hooks: Leaf[] }>
      >;
    };
    const groups = parsed.hooks?.BeforeTool ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("regimen-gate-BeforeTool");
    expect(groups[0]?.matcher).toBe("*");
    const ids = groups[0]?.hooks
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l._regimen?.id);
    expect(ids).toEqual(["rm-rf"]);
    for (const leaf of groups[0]?.hooks ?? []) {
      expect(leaf.command).toContain("REGIMEN_HARNESS=gemini");
    }
    // Not in the config home: project-level only.
    expect(parsed.hooks?.PreToolUse).toBeUndefined();
  });
});

test("gemini: unwireAuthoredGates removes the project-level gate group cleanly", () => {
  withTempDir((workdir) => {
    process.env.REGIMEN_HARNESS = "gemini";
    process.env.GEMINI_CONFIG_DIR = join(workdir, "config");
    inCwd(workdir, () => {
      wireAuthoredGate({ gate: RM_RF, dryRun: false });
      let stdout = "";
      const exit = (() => {
        let code = 1;
        stdout = captureStdout(() => {
          code = unwireAuthoredGates({ dryRun: false });
        });
        return code;
      })();
      expect(exit).toBe(0);
      expect(stdout).toContain("removed gate rm-rf on BeforeTool");
    });

    const parsed = JSON.parse(
      readFileSync(join(workdir, ".gemini", "settings.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    expect(parsed.hooks?.BeforeTool).toBeUndefined();
  });
});
