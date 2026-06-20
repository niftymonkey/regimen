/**
 * The wire-gates / unwire-gates / install / uninstall CLI commands. Spawned
 * against a temp config home so the host's real ~/.codex is never touched. The
 * harness and the config home travel in the environment (REGIMEN_HARNESS and the
 * contract's config-home env var, e.g. CODEX_HOME), never as flags. The pure
 * merge is covered by gate-hooks.test.ts; here we cover the file read/write, the
 * dry-run preview, gate selection, the jq preflight, the fail-closed path when no
 * harness is set, and the best-effort uninstall.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

async function runCli(
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
): Promise<{ exit: number; stdout: string; stderr: string }> {
  // A key set to undefined in the override map is REMOVED from the child env, so
  // a test can scrub an ambient marker (the dev shell sets CLAUDECODE) rather
  // than only mask it with the literal string "undefined".
  const merged: Record<string, string | undefined> = {
    ...process.env,
    REGIMEN_HARNESS: "codex",
    ...env,
  };
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exit: await proc.exited, stdout, stderr };
}

function withCodexHome(
  fn: (codexHome: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-enforce-cli-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

interface Leaf {
  type: string;
  command: string;
  _regimen?: { v: number; role: string; id?: string };
}

interface ParsedHooksFile {
  hooks?: Record<string, Array<{ hooks: Leaf[] }>>;
  [key: string]: unknown;
}

function readHooks(codexHome: string): ParsedHooksFile {
  return JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
}

function readHooksFileNamed(home: string, fileName: string): ParsedHooksFile {
  return JSON.parse(readFileSync(join(home, fileName), "utf8"));
}

function gateLeaves(parsed: ParsedHooksFile): Leaf[] {
  return (parsed.hooks?.PreToolUse ?? [])
    .flatMap((g) => g.hooks)
    .filter((l) => l._regimen?.role === "gate");
}

test("wire-gates writes hooks.json with all three gates on PreToolUse by default", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit } = await runCli(["wire-gates"], { CODEX_HOME: codexHome });
    expect(exit).toBe(0);

    const gateIds = (readHooks(codexHome).hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l._regimen?.id);
    expect(gateIds).toEqual(["rm-rf", "em-dash", "inline-message"]);
  });
});

test("wire-gates fails closed with a clear message when the harness is undetermined", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stderr } = await runCli(["wire-gates"], {
      CODEX_HOME: codexHome,
      REGIMEN_HARNESS: undefined,
      // Scrub every CLI-set marker so detection finds nothing: the install
      // must fail closed, not silently pick a harness.
      CLAUDECODE: undefined,
      CODEX_THREAD_ID: undefined,
      GEMINI_CLI: undefined,
      COPILOT_CLI: undefined,
    });
    expect(exit).not.toBe(0);
    expect(stderr).toContain("REGIMEN_HARNESS");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("wire-gates detects codex from its CLI marker and bakes it into every gate", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit } = await runCli(["wire-gates"], {
      CODEX_HOME: codexHome,
      // No REGIMEN_HARNESS: only the codex CLI marker is present.
      REGIMEN_HARNESS: undefined,
      CLAUDECODE: undefined,
      CODEX_THREAD_ID: "thread-xyz",
    });
    expect(exit).toBe(0);

    const commands = (readHooks(codexHome).hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain("REGIMEN_HARNESS=codex");
    }
  });
});

test("wire-gates detects claude from its CLI marker and bakes it into every gate", async () => {
  await withCodexHome(async (claudeHome) => {
    // Only the claude CLI marker is present, so the detected harness drives the
    // config-home env var read (CLAUDE_CONFIG_DIR) and the baked harness label.
    const { exit } = await runCli(["wire-gates"], {
      CLAUDE_CONFIG_DIR: claudeHome,
      REGIMEN_HARNESS: undefined,
      CODEX_THREAD_ID: undefined,
      CLAUDECODE: "1",
    });
    expect(exit).toBe(0);

    // Claude's hooks live in settings.json per the shared contract, not hooks.json.
    const commands = gateLeaves(
      readHooksFileNamed(claudeHome, "settings.json"),
    ).map((l) => l.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain("REGIMEN_HARNESS=claude");
    }
  });
});

test("wire-gates writes Claude's gates to settings.json, preserving co-hosted config and capture/user leaves", async () => {
  await withCodexHome(async (claudeHome) => {
    // Claude's settings.json co-hosts other config (permissions, env) and may
    // already carry Feedback's capture leaf and a user's own hook. An
    // Enforcement gate install must merge into that file, not overwrite it.
    const existing = {
      permissions: { allow: ["Read", "Bash(git status *)"] },
      env: { FOO: "bar" },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "bun /home/me/capture.ts",
                _regimen: { v: 1, role: "capture" },
              },
              { type: "command", command: "bun /home/me/my-gate.ts" },
            ],
          },
        ],
      },
    };
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(existing));

    const { exit } = await runCli(["wire-gates"], {
      CLAUDE_CONFIG_DIR: claudeHome,
      REGIMEN_HARNESS: "claude",
    });
    expect(exit).toBe(0);

    // The gates landed in settings.json (the contract's per-harness file), not
    // a stray hooks.json.
    expect(existsSync(join(claudeHome, "hooks.json"))).toBe(false);
    const parsed = readHooksFileNamed(claudeHome, "settings.json");

    // Co-hosted top-level config survives verbatim.
    expect(parsed.permissions).toEqual({
      allow: ["Read", "Bash(git status *)"],
    });
    expect(parsed.env).toEqual({ FOO: "bar" });

    // Enforcement's gates are present, baked for claude.
    const gateIds = gateLeaves(parsed).map((l) => l._regimen?.id);
    expect(gateIds).toEqual(["rm-rf", "em-dash", "inline-message"]);

    // The capture leaf and the user's own hook both survive.
    const allLeaves = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    expect(allLeaves.some((l) => l._regimen?.role === "capture")).toBe(true);
    expect(allLeaves.some((l) => l.command === "bun /home/me/my-gate.ts")).toBe(
      true,
    );
  });
});

test("wire-gates --dry-run previews and writes nothing", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stdout } = await runCli(["wire-gates", "--dry-run"], {
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain("would wire gate rm-rf on PreToolUse");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("wire-gates preserves the user's own hooks and is idempotent on re-run", async () => {
  await withCodexHome(async (codexHome) => {
    const userFile = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
        ],
      },
    };
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(userFile));

    await runCli(["wire-gates"], { CODEX_HOME: codexHome });
    const second = await runCli(["wire-gates"], { CODEX_HOME: codexHome });
    expect(second.exit).toBe(0);
    expect(second.stdout).toContain("already wired");

    const pre = (readHooks(codexHome).hooks?.PreToolUse ?? []).flatMap(
      (g) => g.hooks,
    );
    expect(pre.some((l) => l.command === "bun /home/me/my-gate.ts")).toBe(true);
    expect(pre.filter((l) => l._regimen?.id === "rm-rf")).toHaveLength(1);
  });
});

test("wire-gates --gate selects a single gate", async () => {
  await withCodexHome(async (codexHome) => {
    await runCli(["wire-gates", "--gate", "rm-rf"], { CODEX_HOME: codexHome });
    const gateIds = (readHooks(codexHome).hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((l) => l._regimen?.role === "gate")
      .map((l) => l._regimen?.id);
    expect(gateIds).toEqual(["rm-rf"]);
  });
});

test("wire-gates --no-gates writes no gates", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit } = await runCli(["wire-gates", "--no-gates"], {
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    // With no gates and no prior file, there is nothing to wire.
    const parsed = existsSync(join(codexHome, "hooks.json"))
      ? readHooks(codexHome)
      : { hooks: {} };
    const gates = (parsed.hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((l) => l._regimen?.role === "gate");
    expect(gates).toHaveLength(0);
  });
});

test("unwire-gates removes Enforcement's gates and keeps the user's hooks", async () => {
  await withCodexHome(async (codexHome) => {
    const userFile = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
        ],
      },
    };
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(userFile));
    await runCli(["wire-gates"], { CODEX_HOME: codexHome });

    const { exit, stdout } = await runCli(["unwire-gates"], {
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain("removed gate rm-rf on PreToolUse");

    expect(readHooks(codexHome).hooks?.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
    ]);
  });
});

test("unwire-gates removes only Claude's gate leaves from settings.json, keeping co-hosted config and capture/user leaves", async () => {
  await withCodexHome(async (claudeHome) => {
    // Start from a settings.json that co-hosts config plus a capture leaf and a
    // user hook, then add Enforcement's gates, then remove them.
    const existing = {
      permissions: { allow: ["Read"] },
      env: { FOO: "bar" },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "bun /home/me/capture.ts",
                _regimen: { v: 1, role: "capture" },
              },
              { type: "command", command: "bun /home/me/my-gate.ts" },
            ],
          },
        ],
      },
    };
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(existing));
    const claudeEnv = {
      CLAUDE_CONFIG_DIR: claudeHome,
      REGIMEN_HARNESS: "claude",
    };
    await runCli(["wire-gates"], claudeEnv);

    const { exit, stdout } = await runCli(["unwire-gates"], claudeEnv);
    expect(exit).toBe(0);
    expect(stdout).toContain("removed gate rm-rf on PreToolUse");

    const parsed = readHooksFileNamed(claudeHome, "settings.json");
    // Every Enforcement gate leaf is gone.
    expect(gateLeaves(parsed)).toHaveLength(0);
    // Co-hosted top-level config survives.
    expect(parsed.permissions).toEqual({ allow: ["Read"] });
    expect(parsed.env).toEqual({ FOO: "bar" });
    // The capture leaf and the user's own hook survive.
    const allLeaves = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    expect(allLeaves.some((l) => l._regimen?.role === "capture")).toBe(true);
    expect(allLeaves.some((l) => l.command === "bun /home/me/my-gate.ts")).toBe(
      true,
    );
  });
});

test("unwire-gates on a missing file is a clean no-op", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stdout } = await runCli(["unwire-gates"], {
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain("nothing to remove");
  });
});

test("a shell gate without jq on PATH warns; rm-rf alone does not", async () => {
  await withCodexHome(async (codexHome) => {
    const bunOnlyPath = dirname(process.execPath);

    const shell = await runCli(["wire-gates", "--gate", "em-dash"], {
      CODEX_HOME: codexHome,
      PATH: bunOnlyPath,
    });
    expect(shell.stderr).toContain("jq");

    const tsOnly = await runCli(["wire-gates", "--gate", "rm-rf"], {
      CODEX_HOME: codexHome,
      PATH: bunOnlyPath,
    });
    expect(tsOnly.stderr).not.toContain("jq");
  });
});

test("install --dry-run previews the gate wiring and writes nothing", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stdout } = await runCli(["install", "--dry-run"], {
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain("would wire gate rm-rf on PreToolUse");
    expect(stdout).toContain("nothing was changed");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("install then uninstall leaves no gate entries behind", async () => {
  await withCodexHome(async (codexHome) => {
    await runCli(["install"], { CODEX_HOME: codexHome });
    const afterInstall = (readHooks(codexHome).hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((l) => l._regimen?.role === "gate");
    expect(afterInstall.length).toBeGreaterThan(0);

    const { exit } = await runCli(["uninstall"], { CODEX_HOME: codexHome });
    expect(exit).toBe(0);
    const gates = (readHooks(codexHome).hooks?.PreToolUse ?? [])
      .flatMap((g) => g.hooks)
      .filter((l) => l._regimen?.role === "gate");
    expect(gates).toHaveLength(0);
  });
});

test("uninstall is best effort: a failing unwire still runs later teardown", async () => {
  await withCodexHome(async (codexHome) => {
    // A malformed hooks.json makes the unwire step fail (return non-zero).
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({ hooks: "nope" }),
    );

    const { exit, stderr } = await runCli(["uninstall", "--dry-run"], {
      CODEX_HOME: codexHome,
    });
    expect(stderr).toContain("hooks");
    expect(exit).not.toBe(0);
  });
});

test("an unknown command exits non-zero", async () => {
  const { exit } = await runCli(["frobnicate"]);
  expect(exit).not.toBe(0);
});
