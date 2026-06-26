/**
 * The install-skill planner (pure) and the CLI command that uses it. The planner
 * is exercised directly; the command is driven IN-PROCESS through the exported
 * `installSkill` facade (ADR-0012, rather than spawning a `bun` subprocess per
 * assertion, which raced this suite's per-test timeout under load) against a temp
 * CODEX_HOME, so the host's real Codex home is never touched.
 *
 * Each CLI test pins CODEX_HOME and REGIMEN_HARNESS in `process.env` (clearing
 * the ambient harness markers first so the suite is independent of whichever
 * harness CLI runs it) and captures stdout/stderr by patching the write streams;
 * `afterEach` restores both the env and the streams.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessContract, planSkillInstall } from "@regimen/shared";
import { dispatchFeedback } from "./facade-dispatch.ts";

const CONTRACT = harnessContract("codex");
if (CONTRACT === undefined) throw new Error("no codex contract registered");

/**
 * The per-harness marker env vars the resolver falls back to when REGIMEN_HARNESS
 * is unset; cleared in beforeEach so the suite resolves the pinned codex harness
 * rather than whichever harness CLI happens to be running it.
 */
const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];

/** The env keys this suite pins or clears, captured and restored per test. */
const MANAGED_ENV = [...HARNESS_MARKERS, "CODEX_HOME"];

let savedEnv: Record<string, string | undefined>;
let savedStdoutWrite: typeof process.stdout.write;
let savedStderrWrite: typeof process.stderr.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  for (const marker of HARNESS_MARKERS) delete process.env[marker];
  savedStdoutWrite = process.stdout.write.bind(process.stdout);
  savedStderrWrite = process.stderr.write.bind(process.stderr);
});

afterEach(() => {
  process.stdout.write = savedStdoutWrite;
  process.stderr.write = savedStderrWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Pin env overrides for one call, then drive the facade dispatch in-process. */
async function runCliWith(
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  const exit = await dispatchFeedback(args);
  return { exit, stdout, stderr };
}

function withCodexHome(
  fn: (codexHome: string) => Promise<void>,
): Promise<void> {
  return fn(tempDir("regimen-install-skill-"));
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
    const { exit, stdout } = await runCliWith(["install-skill", "--dry-run"], {
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
    const { exit, stdout } = await runCliWith(["install-skill"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(exit).toBe(0);

    const evidence = join(codexHome, "skills", "feedback-evidence", "SKILL.md");
    expect(stdout).toContain(`installed ${evidence}`);
    const evidenceContent = readFileSync(evidence, "utf8");
    expect(evidenceContent).toContain("name: feedback-evidence");
    // The bundled skill names no harness and uses the neutral unified command.
    expect(evidenceContent).toContain("regimen evidence");
    expect(evidenceContent).not.toContain("--harness");

    const judgment = join(codexHome, "skills", "feedback-judgment", "SKILL.md");
    expect(stdout).toContain(`installed ${judgment}`);
    const judgmentContent = readFileSync(judgment, "utf8");
    expect(judgmentContent).toContain("name: feedback-judgment");
    expect(judgmentContent).toContain("regimen assess");
    expect(judgmentContent).not.toContain("--harness");
  });
});

test("install-skill overwrites an existing install (idempotent re-run)", async () => {
  await withCodexHome(async (codexHome) => {
    const first = await runCliWith(["install-skill"], {
      REGIMEN_HARNESS: "codex",
      CODEX_HOME: codexHome,
    });
    expect(first.exit).toBe(0);
    const second = await runCliWith(["install-skill"], {
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
