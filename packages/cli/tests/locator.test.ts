/**
 * The InstrumentLocator. Tests build a temp fixture tree modeling the workspace
 * `packages/` parent: sibling package dirs (`cli`, `feedback`, `enforcement`),
 * each with a stub `src/cli/index.ts`. The cli package root and the environment
 * are injected so the named-sibling convention and the override chain are
 * exercised against real files with a controlled env and no mocking. Dependency
 * category 2: filesystem + env only.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LocateError,
  type LocateResult,
  locate,
  locateAll,
} from "../src/locator.ts";

/**
 * Build a `packages/` parent dir with the named sibling packages present (by
 * default both), each carrying a stub `src/cli/index.ts`, and return the parent
 * plus the cli package root inside it. Pass a subset of names to omit a package
 * for miss tests.
 */
function withSiblingTree(
  fn: (tree: { parent: string; hubCloneRoot: string }) => void,
  present: ReadonlyArray<string> = ["feedback", "enforcement"],
): void {
  const parent = mkdtempSync(join(tmpdir(), "regimen-packages-locator-"));
  try {
    const makePackage = (name: string): string => {
      const root = join(parent, name);
      mkdirSync(join(root, "src", "cli"), { recursive: true });
      writeFileSync(join(root, "src", "cli", "index.ts"), "// stub entry\n");
      return root;
    };
    const hubCloneRoot = makePackage("cli");
    for (const name of present) makePackage(name);
    fn({ parent, hubCloneRoot });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function isError(value: LocateResult | LocateError): value is LocateError {
  return "message" in value;
}

function entryOf(value: LocateResult | LocateError | undefined): string | null {
  return value && !isError(value) ? value.entryPath : null;
}

test("the named-sibling convention resolves both instruments from the cli package root", () => {
  withSiblingTree(({ parent, hubCloneRoot }) => {
    const results = locateAll({ hubCloneRoot, env: {}, overrides: {} });

    expect(entryOf(results.get("feedback"))).toBe(
      join(parent, "feedback", "src", "cli", "index.ts"),
    );
    expect(entryOf(results.get("enforcement"))).toBe(
      join(parent, "enforcement", "src", "cli", "index.ts"),
    );
  });
});

test("an explicit flag override beats the env override, which beats the convention", () => {
  withSiblingTree(({ parent, hubCloneRoot }) => {
    // Two extra clones to point the flag and env at, distinct from the sibling.
    const flagRoot = join(parent, "flag-clone");
    const envRoot = join(parent, "env-clone");
    for (const root of [flagRoot, envRoot]) {
      mkdirSync(join(root, "src", "cli"), { recursive: true });
      writeFileSync(join(root, "src", "cli", "index.ts"), "// stub\n");
    }

    const flagWins = locate("feedback", {
      hubCloneRoot,
      env: { REGIMEN_FEEDBACK_PATH: envRoot },
      overrides: { feedbackPath: flagRoot },
    });
    expect(entryOf(flagWins)).toBe(join(flagRoot, "src", "cli", "index.ts"));

    const envWins = locate("feedback", {
      hubCloneRoot,
      env: { REGIMEN_FEEDBACK_PATH: envRoot },
      overrides: {},
    });
    expect(entryOf(envWins)).toBe(join(envRoot, "src", "cli", "index.ts"));

    const conventionWins = locate("feedback", {
      hubCloneRoot,
      env: {},
      overrides: {},
    });
    expect(entryOf(conventionWins)).toBe(
      join(parent, "feedback", "src", "cli", "index.ts"),
    );
  });
});

test("empty-string overrides fall through to the next precedence level", () => {
  withSiblingTree(({ parent, hubCloneRoot }) => {
    const envRoot = join(parent, "env-clone");
    mkdirSync(join(envRoot, "src", "cli"), { recursive: true });
    writeFileSync(join(envRoot, "src", "cli", "index.ts"), "// stub\n");

    // An empty flag override is not a selection; it falls through to the env.
    const emptyFlagFallsToEnv = locate("feedback", {
      hubCloneRoot,
      env: { REGIMEN_FEEDBACK_PATH: envRoot },
      overrides: { feedbackPath: "" },
    });
    expect(entryOf(emptyFlagFallsToEnv)).toBe(
      join(envRoot, "src", "cli", "index.ts"),
    );

    // An empty env override falls through to the named-sibling convention.
    const emptyEnvFallsToConvention = locate("feedback", {
      hubCloneRoot,
      env: { REGIMEN_FEEDBACK_PATH: "" },
      overrides: {},
    });
    expect(entryOf(emptyEnvFallsToConvention)).toBe(
      join(parent, "feedback", "src", "cli", "index.ts"),
    );
  });
});

test("a missing clone yields a typed error naming the instrument, the tried path, and the override knobs", () => {
  withSiblingTree(
    ({ parent, hubCloneRoot }) => {
      const results = locateAll({ hubCloneRoot, env: {}, overrides: {} });

      // enforcement is present; feedback is absent (omitted from the tree).
      expect(isError(results.get("enforcement")!)).toBe(false);

      const feedback = results.get("feedback")!;
      expect(isError(feedback)).toBe(true);
      const err = feedback as LocateError;
      expect(err.instrument).toBe("feedback");
      expect(err.triedPath).toBe(
        join(parent, "feedback", "src", "cli", "index.ts"),
      );
      expect(err.flag).toBe("--feedback-path");
      expect(err.envVar).toBe("REGIMEN_FEEDBACK_PATH");
      expect(err.message).toContain("feedback");
      expect(err.message).toContain(err.triedPath);
      expect(err.message).toContain("--feedback-path");
      expect(err.message).toContain("REGIMEN_FEEDBACK_PATH");
    },
    ["enforcement"],
  );
});

test("resolution is identical for install and uninstall (the locator is verb-agnostic)", () => {
  withSiblingTree(({ hubCloneRoot }) => {
    const a = locateAll({ hubCloneRoot, env: {}, overrides: {} });
    const b = locateAll({ hubCloneRoot, env: {}, overrides: {} });
    expect(entryOf(a.get("feedback"))).toBe(entryOf(b.get("feedback")));
    expect(entryOf(a.get("enforcement"))).toBe(entryOf(b.get("enforcement")));
  });
});
