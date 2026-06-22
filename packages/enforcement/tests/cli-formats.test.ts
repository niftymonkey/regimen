/**
 * The wire-gates / unwire-gates commands for the two divergent install shapes,
 * driven in-process against the exported facade functions (ADR-0012). Copilot
 * writes the `versioned-command-leaves` file at `$COPILOT_HOME/hooks/hooks.json`
 * (flat leaves under a top-level `version`, on `preToolUse`). Gemini installs
 * PROJECT-level: the gates land in `<cwd>/.gemini/settings.json` (named+matched
 * nested groups on `BeforeTool`), not in the config home, because only a
 * project-level settings file fires headless (ADR-0011,
 * docs/harness-divergences.md). The pure merge is covered by
 * gate-hooks-formats.test.ts; here we cover that the command writes the right
 * file at the right path with the right shape, and removes it cleanly.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GateId, unwireGates, wireGates } from "../src/cli/index.ts";

const DEFAULT_GATES: ReadonlyArray<GateId> = [
  "rm-rf",
  "em-dash",
  "inline-message",
];

/** Parse the gate selection out of the argv the old subprocess form carried. */
function parseGates(args: ReadonlyArray<string>): GateId[] {
  if (args.includes("--no-gates")) return [];
  const selected: GateId[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i + 1];
    if (args[i] === "--gate" && value !== undefined) {
      selected.push(value as GateId);
    }
  }
  return selected.length > 0 ? selected : [...DEFAULT_GATES];
}

/**
 * Drive a facade in-process with the same argv/env/cwd contract the old
 * subprocess helper exposed, so every test below is untouched. Env overrides are
 * applied onto process.env (undefined DELETES the key) and restored in a finally
 * block; when a cwd is given the process is chdir'd into it for the call (the
 * gemini project-level install reads process.cwd() directly) and restored after.
 * stdout/stderr are captured by patching the stream writers.
 */
async function runCli(
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  cwd?: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const savedCwd = process.cwd();
  if (cwd !== undefined) process.chdir(cwd);

  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const command = args[0];
    const dryRun = args.includes("--dry-run");
    const gates = parseGates(args);
    let exit: number;
    switch (command) {
      case "wire-gates":
        exit = wireGates({ gates, dryRun });
        break;
      case "unwire-gates":
        exit = unwireGates({ dryRun });
        break;
      default:
        throw new Error(`unknown command in test: ${String(command)}`);
    }
    return { exit, stdout, stderr };
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-fmt-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

interface Leaf {
  type: string;
  command: string;
  env?: Record<string, string>;
  _regimen?: { v: number; role: string; id?: string };
}

test("copilot: wire-gates writes versioned flat gate leaves at hooks/hooks.json", async () => {
  await withTempDir(async (copilotHome) => {
    const { exit } = await runCli(["wire-gates"], {
      REGIMEN_HARNESS: "copilot",
      COPILOT_HOME: copilotHome,
    });
    expect(exit).toBe(0);

    const parsed = JSON.parse(
      readFileSync(join(copilotHome, "hooks", "hooks.json"), "utf8"),
    ) as { version?: number; hooks?: Record<string, Leaf[]> };
    expect(parsed.version).toBe(1);
    const leaves = parsed.hooks?.preToolUse ?? [];
    // Flat leaves, no matcher-group wrapper, each marked role:gate, baked for copilot.
    const gateIds = leaves
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l._regimen?.id);
    expect(gateIds).toEqual(["rm-rf", "em-dash", "inline-message"]);
    for (const leaf of leaves) {
      expect((leaf as { hooks?: unknown }).hooks).toBeUndefined();
      expect(leaf.command).toContain("REGIMEN_HARNESS=copilot");
    }
    expect(parsed.hooks?.PreToolUse).toBeUndefined();
  });
});

test("gemini: wire-gates installs project-level at <cwd>/.gemini/settings.json with name+matcher on BeforeTool", async () => {
  await withTempDir(async (workdir) => {
    const { exit } = await runCli(
      ["wire-gates"],
      { REGIMEN_HARNESS: "gemini", GEMINI_CONFIG_DIR: join(workdir, "config") },
      workdir,
    );
    expect(exit).toBe(0);

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
    const gateIds = groups[0]?.hooks
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l._regimen?.id);
    expect(gateIds).toEqual(["rm-rf", "em-dash", "inline-message"]);
    for (const leaf of groups[0]?.hooks ?? []) {
      expect(leaf.command).toContain("REGIMEN_HARNESS=gemini");
    }
    // Not in the config home: project-level only.
    expect(parsed.hooks?.PreToolUse).toBeUndefined();
  });
});

test("gemini: unwire-gates removes the project-level gate group cleanly", async () => {
  await withTempDir(async (workdir) => {
    const env = {
      REGIMEN_HARNESS: "gemini",
      GEMINI_CONFIG_DIR: join(workdir, "config"),
    };
    await runCli(["wire-gates"], env, workdir);
    const { exit, stdout } = await runCli(["unwire-gates"], env, workdir);
    expect(exit).toBe(0);
    expect(stdout).toContain("removed gate rm-rf on BeforeTool");

    const parsed = JSON.parse(
      readFileSync(join(workdir, ".gemini", "settings.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    expect(parsed.hooks?.BeforeTool).toBeUndefined();
  });
});

test("copilot: unwire-gates removes the versioned gate leaves cleanly", async () => {
  await withTempDir(async (copilotHome) => {
    const env = {
      REGIMEN_HARNESS: "copilot",
      COPILOT_HOME: copilotHome,
    };
    await runCli(["wire-gates"], env);
    const { exit, stdout } = await runCli(["unwire-gates"], env);
    expect(exit).toBe(0);
    expect(stdout).toContain("removed gate rm-rf on preToolUse");

    const parsed = JSON.parse(
      readFileSync(join(copilotHome, "hooks", "hooks.json"), "utf8"),
    ) as { hooks?: Record<string, Leaf[]> };
    const leaves = parsed.hooks?.preToolUse ?? [];
    expect(leaves.some((l) => l._regimen?.role === "gate")).toBe(false);
  });
});
