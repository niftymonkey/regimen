/**
 * The install-skill planner (pure) and the CLI command that uses it. The
 * planner is exercised directly; the command is spawned against a temp
 * CODEX_HOME so the host's real Codex home is never touched.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSkillInstall } from "../src/cli/install/skill.ts";
import { harnessContract } from "../src/harness/contract.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

const CONTRACT = harnessContract("codex");
if (CONTRACT === undefined) throw new Error("no codex contract registered");

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
  const dir = mkdtempSync(join(tmpdir(), "regimen-install-skill-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the planner resolves a source and harness-home target for every bundled skill", () => {
  const plans = planSkillInstall({
    home: "/home/me/.codex",
    bundleDir: "/repo",
    contract: CONTRACT,
  });
  const byName = new Map(plans.map((p) => [p.name, p]));
  expect([...byName.keys()].sort()).toEqual([
    "feedback-evidence",
    "feedback-judgment",
  ]);
  for (const name of ["feedback-evidence", "feedback-judgment"]) {
    const plan = byName.get(name);
    expect(plan?.sourcePath).toBe(`/repo/skills/${name}/SKILL.md`);
    expect(plan?.targetPath).toBe(
      `/home/me/.codex/${CONTRACT.skillsSubdir}/${name}/SKILL.md`,
    );
  }
});

test("the skills target subdirectory is the contract's, not a hardcoded literal", () => {
  // A fabricated contract with a different skills subdirectory proves the planner
  // reads contract DATA: a harness whose skills live elsewhere flows through
  // without editing the planner.
  const other = { ...CONTRACT, skillsSubdir: "agents/skills" };
  const plans = planSkillInstall({
    home: "/srv/agent-home",
    bundleDir: "/repo",
    contract: other,
  });
  for (const plan of plans) {
    expect(plan.targetPath).toBe(
      `/srv/agent-home/agents/skills/${plan.name}/SKILL.md`,
    );
  }
});

test("install-skill --dry-run reports both target paths and writes nothing", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stdout } = await runCli(["install-skill", "--dry-run"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);
    for (const name of ["feedback-evidence", "feedback-judgment"]) {
      const target = join(codexHome, "skills", name, "SKILL.md");
      expect(stdout).toContain(`would write ${target}`);
      expect(existsSync(target)).toBe(false);
    }
  });
});

test("install-skill copies both bundled SKILL.md files into CODEX_HOME/skills", async () => {
  await withCodexHome(async (codexHome) => {
    const { exit, stdout } = await runCli(["install-skill"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);

    const evidence = join(codexHome, "skills", "feedback-evidence", "SKILL.md");
    expect(stdout).toContain(`installed ${evidence}`);
    const evidenceContent = readFileSync(evidence, "utf8");
    expect(evidenceContent).toContain("name: feedback-evidence");
    // The bundled skill names no harness and uses the neutral command.
    expect(evidenceContent).toContain("feedback evidence");
    expect(evidenceContent).not.toContain("--harness");

    const judgment = join(codexHome, "skills", "feedback-judgment", "SKILL.md");
    expect(stdout).toContain(`installed ${judgment}`);
    const judgmentContent = readFileSync(judgment, "utf8");
    expect(judgmentContent).toContain("name: feedback-judgment");
    expect(judgmentContent).toContain("feedback assess");
    expect(judgmentContent).not.toContain("--harness");
  });
});

test("install-skill overwrites an existing install (idempotent re-run)", async () => {
  await withCodexHome(async (codexHome) => {
    const first = await runCli(["install-skill"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(first.exit).toBe(0);
    const second = await runCli(["install-skill"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(second.exit).toBe(0);
    const evidence = join(codexHome, "skills", "feedback-evidence", "SKILL.md");
    expect(readFileSync(evidence, "utf8")).toContain("name: feedback-evidence");
    const judgment = join(codexHome, "skills", "feedback-judgment", "SKILL.md");
    expect(readFileSync(judgment, "utf8")).toContain("name: feedback-judgment");
  });
});
