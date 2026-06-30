/**
 * The live SetupSource adapter discovers the engineer's stated conventions and
 * established practices from the filesystem and normalizes them to the neutral
 * EngineerSetup. These tests run entirely against a temporary fixture: a project
 * dir, an injected home dir, and a fake practice dir, so nothing touches the
 * developer's real home. They assert the convention text and practice
 * name/summary are discovered, that scope is provenance-only (no file name or
 * harness leaks), and that an empty fixture yields undefined.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveSetupSource } from "../src/judged/live-setup-source.ts";

const ASOF = new Date("2026-06-30T00:00:00.000Z");

let root: string;
let projectDir: string;
let homeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "regimen-setup-src-"));
  projectDir = join(root, "project");
  homeDir = join(root, "home");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `home/.claude/skills/<name>/SKILL.md` with the given frontmatter. */
function writeSkill(name: string, frontmatter: string): void {
  const dir = join(homeDir, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), frontmatter);
}

test("discovers a project convention's text and a practice's name and summary", () => {
  writeFileSync(
    join(projectDir, "CLAUDE.md"),
    "Harness- and model-agnostic by default.",
  );
  writeSkill(
    "tdd",
    '---\nname: tdd\ndescription: "red-green-refactor before writing code"\n---\n# tdd\n',
  );

  const setup = createLiveSetupSource({ homeDir }).resolve({
    cwd: projectDir,
    asOf: ASOF,
  });

  expect(setup).toBeDefined();
  expect(
    setup?.conventions.some((c) => c.text.includes("model-agnostic")),
  ).toBe(true);
  const tdd = setup?.practices.find((p) => p.name === "tdd");
  expect(tdd?.summary).toBe("red-green-refactor before writing code");
});

test("tags a project file as project scope and a home file as global scope", () => {
  writeFileSync(join(projectDir, "CLAUDE.md"), "Prefer pnpm over npm.");
  writeFileSync(join(homeDir, "AGENTS.md"), "Keep explanations concise.");

  const setup = createLiveSetupSource({ homeDir }).resolve({
    cwd: projectDir,
    asOf: ASOF,
  });

  const project = setup?.conventions.find((c) => c.scope === "project");
  const global = setup?.conventions.find((c) => c.scope === "global");
  expect(project?.text).toBe("Prefer pnpm over npm.");
  expect(global?.text).toBe("Keep explanations concise.");
});

test("leaks no file name and no harness or model identity into the result", () => {
  writeFileSync(join(projectDir, "CLAUDE.md"), "Prefer pnpm over npm.");
  writeFileSync(join(homeDir, "AGENTS.md"), "Keep explanations concise.");
  writeSkill(
    "work-router",
    "---\nname: work-router\ndescription: route off-thread work by default\n---\n",
  );

  const setup = createLiveSetupSource({ homeDir }).resolve({
    cwd: projectDir,
    asOf: ASOF,
  });
  const serialized = JSON.stringify(setup);

  for (const leak of [
    "CLAUDE.md",
    "AGENTS.md",
    "GEMINI.md",
    "SKILL.md",
    "Claude",
    "Gemini",
  ]) {
    expect(serialized).not.toContain(leak);
  }
  for (const convention of setup?.conventions ?? []) {
    expect(["project", "global"]).toContain(convention.scope);
    expect(Object.keys(convention).sort()).toEqual(["scope", "text"]);
  }
  for (const practice of setup?.practices ?? []) {
    expect(Object.keys(practice).sort()).toEqual(["name", "summary"]);
  }
});

test("falls back to a skill's leading words when it has no frontmatter description", () => {
  writeSkill(
    "diagnose",
    "---\nname: diagnose\n---\n# diagnose\n\nDisciplined diagnosis loop for hard bugs.\n",
  );

  const setup = createLiveSetupSource({ homeDir }).resolve({
    cwd: projectDir,
    asOf: ASOF,
  });

  const diagnose = setup?.practices.find((p) => p.name === "diagnose");
  expect(diagnose?.summary).toBe("Disciplined diagnosis loop for hard bugs.");
});

test("returns undefined when nothing is discoverable", () => {
  const setup = createLiveSetupSource({ homeDir }).resolve({
    cwd: projectDir,
    asOf: ASOF,
  });

  expect(setup).toBeUndefined();
});
