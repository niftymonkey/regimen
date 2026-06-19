/**
 * The wire-hooks / unwire-hooks CLI commands (capture-only). Spawned against a
 * temp CODEX_HOME so the host's real ~/.codex is never touched, mirroring
 * install-skill.test.ts. The pure merge is covered by install-codex-hooks.test.ts;
 * here we cover the file read/write and the dry-run preview.
 *
 * Feedback wires only the capture hook; enforcement gates come from the separate
 * regimen-enforcement repo, so no gate leaves are ever written here.
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
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

async function runCli(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
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
  const dir = mkdtempSync(join(tmpdir(), "regimen-wire-hooks-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

interface Leaf {
  type: string;
  command: string;
  _regimen?: { v: number; role: string; id?: string };
}

function readHooks(codexHome: string): {
  hooks?: Record<string, Array<{ hooks: Leaf[] }>>;
} {
  return JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
}

test("wire-hooks writes hooks.json with capture on five events and no gate leaves", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit } = await runCli(["wire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);

    const parsed = readHooks(codexHome);
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
    ]) {
      const leaves = (parsed.hooks?.[event] ?? []).flatMap((g) => g.hooks);
      expect(leaves.some((l) => l._regimen?.role === "capture")).toBe(true);
      // No event carries a gate leaf: Feedback wires capture only.
      expect(leaves.filter((l) => l._regimen?.role === "gate")).toHaveLength(0);
    }
  });
});

test("wire-hooks fails closed when no harness can be resolved", async () => {
  await withCodexHome(async (codexHome) => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CODEX_THREAD_ID;
    delete env.GEMINI_CLI;
    delete env.COPILOT_CLI;
    delete env.REGIMEN_HARNESS;
    env.CODEX_HOME = codexHome;
    const proc = Bun.spawn(["bun", CLI, "wire-hooks"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain("could not determine the harness");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("wire-hooks fails closed on a known harness with no registered descriptor", async () => {
  await withCodexHome(async (codexHome) => {
    // `gemini` is a valid harness identifier but has no descriptor registered
    // yet, so the install path must refuse it rather than guess.
    const { exit, stderr } = await runCli(["wire-hooks"], {
      REGIMEN_HARNESS: "gemini",
      CODEX_HOME: codexHome,
    });
    expect(exit).not.toBe(0);
    expect(stderr).toContain("unsupported harness");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("wire-hooks --dry-run previews capture only and writes nothing", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stdout } = await runCli(["wire-hooks", "--dry-run"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain("would wire capture on SessionStart");
    expect(stdout).toContain("would wire capture on PreToolUse");
    // Capture-only: nothing about gates is ever previewed.
    expect(stdout).not.toContain("gate");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });
});

test("wire-hooks preserves the user's own hooks and is idempotent on re-run", async () => {
  await withCodexHome(async (codexHome) => {
    const userFile = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
        ],
      },
    };
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(userFile));

    await runCli(["wire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    const second = await runCli(["wire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(second.exit).toBe(0);
    expect(second.stdout).toContain("already wired");

    const parsed = readHooks(codexHome);
    const pre = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    // The user's gate survives, exactly one capture leaf exists (no duplicate).
    expect(pre.some((l) => l.command === "bun /home/me/my-gate.ts")).toBe(true);
    expect(pre.filter((l) => l._regimen?.role === "capture")).toHaveLength(1);
  });
});

test("wire-hooks preserves a foreign enforcement gate leaf verbatim", async () => {
  await withCodexHome(async (codexHome) => {
    const gateLeaf = {
      type: "command",
      command: "bun /opt/regimen-enforcement/gates/rm-rf.ts",
      _regimen: { v: 1, role: "gate", id: "rm-rf" },
    };
    const enforcementFile = {
      hooks: { PreToolUse: [{ hooks: [gateLeaf] }] },
    };
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify(enforcementFile),
    );

    await runCli(["wire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });

    const parsed = readHooks(codexHome);
    const pre = (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    // The enforcement gate leaf is untouched; Feedback's capture lands after it.
    expect(pre.find((l) => l._regimen?.role === "gate")).toEqual(gateLeaf);
    expect(pre.filter((l) => l._regimen?.role === "capture")).toHaveLength(1);

    // Unwiring removes only Feedback's capture, leaving the gate leaf in place.
    await runCli(["unwire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    const after = readHooks(codexHome);
    const preAfter = (after.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
    expect(preAfter).toEqual([gateLeaf]);
  });
});

test("unwire-hooks removes Feedback's entries and keeps the user's", async () => {
  await withCodexHome(async (codexHome) => {
    const userFile = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
        ],
      },
    };
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(userFile));
    await runCli(["wire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });

    const { exit, stdout } = await runCli(["unwire-hooks"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    expect(stdout).toContain("removed capture on SessionStart");

    const parsed = readHooks(codexHome);
    expect(parsed.hooks?.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "bun /home/me/my-gate.ts" }] },
    ]);
    expect(parsed.hooks?.SessionStart).toBeUndefined();
  });
});

/** A fully isolated environment: temp HOME, temp CODEX_HOME, temp data dir. */
function withInstallEnv(
  fn: (env: {
    codexHome: string;
    home: string;
    cliEnv: Record<string, string>;
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "regimen-install-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "regimen-install-codex-"));
  const dataDir = mkdtempSync(join(tmpdir(), "regimen-install-data-"));
  const cliEnv = {
    HOME: home,
    REGIMEN_HARNESS: "codex",
    CODEX_HOME: codexHome,
    REGIMEN_DATA_DIR: dataDir,
  };
  return fn({ codexHome, home, cliEnv }).finally(() => {
    for (const d of [home, codexHome, dataDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

test("install --dry-run previews a capture-only wiring with zero gate leaves and writes nothing", async () => {
  await withInstallEnv(async ({ codexHome, cliEnv }) => {
    const { exit, stdout } = await runCli(["install", "--dry-run"], cliEnv);
    expect(exit).toBe(0);
    // Feedback: enable + daemon service.
    expect(stdout).toContain("would enable feedback");
    expect(stdout).toMatch(/would write .*regimen-feedback/);
    // Capture hook, on PreToolUse among the five events.
    expect(stdout).toContain("would wire capture on PreToolUse");
    // No gates: Feedback no longer wires enforcement.
    expect(stdout).not.toContain("gate");
    // Guidance: both bundled skills.
    expect(stdout).toContain("feedback-evidence/SKILL.md");
    expect(stdout).toContain("feedback-judgment/SKILL.md");
    // CLI on PATH.
    expect(stdout).toContain("would run: bun link");
    expect(stdout).toContain("nothing was changed");

    // No side effects.
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(codexHome, "skills", "feedback-evidence"))).toBe(
      false,
    );
  });
});

test("uninstall --dry-run previews teardown and writes nothing", async () => {
  await withInstallEnv(async ({ codexHome, cliEnv }) => {
    // Pre-wire a real hooks.json so the teardown has something to preview.
    await runCli(["wire-hooks"], cliEnv);
    const before = readFileSync(join(codexHome, "hooks.json"), "utf8");

    const { exit, stdout } = await runCli(["uninstall", "--dry-run"], cliEnv);
    expect(exit).toBe(0);
    expect(stdout).toContain("would disable feedback");
    expect(stdout).toContain("would remove capture on PreToolUse");
    expect(stdout).toContain("would run: bun unlink");
    expect(stdout).toContain("nothing was changed");

    // The hooks.json is untouched by a dry run.
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toBe(before);
  });
});

test("uninstall is best effort: a failing early step does not skip later teardown", async () => {
  await withInstallEnv(async ({ codexHome, cliEnv }) => {
    // A malformed hooks.json makes the unwire step fail (return non-zero).
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({ hooks: "nope" }),
    );

    const { exit, stdout, stderr } = await runCli(
      ["uninstall", "--dry-run"],
      cliEnv,
    );
    // The failure is surfaced and propagated to the exit code.
    expect(stderr).toContain("hooks");
    expect(exit).not.toBe(0);
    // But the later steps still ran (skill + daemon teardown previews present),
    // which a short-circuiting `||=` would have skipped.
    expect(stdout).toContain("would remove");
    expect(stdout).toContain("feedback-evidence");
    expect(stdout).toContain("would run: bun unlink");
  });
});
