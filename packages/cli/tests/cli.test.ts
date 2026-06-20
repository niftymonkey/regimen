/**
 * The Regimen CLI composition root. A thin arg-parse test (argv -> ParsedArgs) and
 * one end-to-end dry-run smoke spawned against temp instrument clones, since the
 * CLI holds no logic worth deep testing (the depth is in the locator and the
 * planner, covered by their own suites).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessChildEnv, parseArgs } from "../src/cli/index.ts";

test("parseArgs reads the verb, the shared flags, the gate flags, and the override knobs", () => {
  const parsed = parseArgs([
    "install",
    "--dry-run",
    "--gate",
    "rm-rf",
    "--gate",
    "em-dash",
    "--with-bridge",
    "--feedback-path",
    "/clones/regimen-feedback",
    "--enforcement-path",
    "/clones/regimen-enforcement",
  ]);

  expect(parsed.verb).toBe("install");
  // No config home flag: the harness config home travels in the child env.
  expect(parsed.config).toEqual({
    dryRun: true,
    gates: ["rm-rf", "em-dash"],
    noGates: false,
    withBridge: true,
  });
  expect(parsed.overrides).toEqual({
    feedbackPath: "/clones/regimen-feedback",
    enforcementPath: "/clones/regimen-enforcement",
  });
});

test("parseArgs defaults: bare uninstall has no flags set", () => {
  const parsed = parseArgs(["uninstall"]);
  expect(parsed.verb).toBe("uninstall");
  expect(parsed.config).toEqual({
    dryRun: false,
    gates: [],
    noGates: false,
    withBridge: false,
  });
  expect(parsed.overrides).toEqual({});
});

test("parseArgs reads --no-gates", () => {
  const parsed = parseArgs(["install", "--no-gates"]);
  expect(parsed.config.noGates).toBe(true);
});

test("harnessChildEnv copies REGIMEN_HARNESS into the child overlay when set", () => {
  expect(harnessChildEnv({ REGIMEN_HARNESS: "codex" })).toEqual({
    REGIMEN_HARNESS: "codex",
  });
});

test("harnessChildEnv returns undefined when REGIMEN_HARNESS is unset or empty", () => {
  expect(harnessChildEnv({})).toBeUndefined();
  expect(harnessChildEnv({ REGIMEN_HARNESS: "" })).toBeUndefined();
});

const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli", "index.ts");

/** A runnable stub instrument CLI that echoes its argv and the harness env, exits 0. */
const STUB_CLI = `#!/usr/bin/env bun
process.stdout.write("STUB " + process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("STUB_HARNESS " + (process.env.REGIMEN_HARNESS ?? "") + "\\n");
process.exit(0);
`;

function makeStubClone(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, "src", "cli"), { recursive: true });
  writeFileSync(join(root, "src", "cli", "index.ts"), STUB_CLI);
  return root;
}

test("install --dry-run prints the ordered plan and forwards --dry-run to both children", async () => {
  const parent = mkdtempSync(join(tmpdir(), "regimen-cli-smoke-"));
  try {
    const feedback = makeStubClone(parent, "regimen-feedback");
    const enforcement = makeStubClone(parent, "regimen-enforcement");

    const proc = Bun.spawn(
      [
        "bun",
        CLI_ENTRY,
        "install",
        "--dry-run",
        "--feedback-path",
        feedback,
        "--enforcement-path",
        enforcement,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;

    expect(exit).toBe(0);
    expect(stdout).toContain("Regimen install (Feedback + Enforcement)");
    // The plan lists feedback before enforcement.
    expect(stdout.indexOf("feedback: bun")).toBeLessThan(
      stdout.indexOf("enforcement: bun"),
    );
    // Both children actually ran with --dry-run forwarded.
    expect(stdout).toContain("STUB install --dry-run");
    const stubLines = stdout
      .split("\n")
      .filter((l) => l.startsWith("STUB install --dry-run"));
    expect(stubLines).toHaveLength(2);
    // The cli self-link is previewed last in the plan, after both instruments,
    // and under --dry-run it is preview-only (it never spawns a real bun link).
    expect(stdout).toContain("cli: bun link");
    expect(stdout.indexOf("enforcement: bun")).toBeLessThan(
      stdout.indexOf("cli: bun link"),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("install hands the harness to each child via REGIMEN_HARNESS in the env, not a flag", async () => {
  const parent = mkdtempSync(join(tmpdir(), "regimen-cli-harness-"));
  try {
    const feedback = makeStubClone(parent, "regimen-feedback");
    const enforcement = makeStubClone(parent, "regimen-enforcement");

    const proc = Bun.spawn(
      [
        "bun",
        CLI_ENTRY,
        "install",
        "--dry-run",
        "--feedback-path",
        feedback,
        "--enforcement-path",
        enforcement,
      ],
      {
        env: { ...process.env, REGIMEN_HARNESS: "codex" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    // Both children saw the harness as an env string, and neither got a flag.
    const harnessLines = stdout
      .split("\n")
      .filter((l) => l.startsWith("STUB_HARNESS"));
    expect(harnessLines).toEqual(["STUB_HARNESS codex", "STUB_HARNESS codex"]);
    expect(stdout).not.toContain("--harness");
    expect(stdout).not.toContain("--codex-home");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
