/**
 * `regimen update` prunes dead Regimen-owned hook leaves: for each recorded
 * manifest entry it opens that harness's hooks file (honoring the entry's scope),
 * removes every marked leaf whose script is gone AND provably inside a Regimen
 * clone, reports (never removes) marked dead leaves outside every clone, and
 * leaves unmarked and live leaves alone. Driven end to end against real hooks
 * files in a per-test temp workspace, with the clone roots supplied as data so no
 * real clone need exist; a missing hooks file is a no-op, and `--dry-run` writes
 * nothing.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstrumentSteps,
  type LifecycleDeps,
  pruneDeadHooks,
  update,
} from "../src/cli/index.ts";
import type { LeafHook } from "@regimen/shared";
import {
  type Manifest,
  type ManifestEntry,
  manifestPath,
  writeManifest,
} from "../src/manifest.ts";

const tempDirs: string[] = [];
let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.REGIMEN_DATA_DIR;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.REGIMEN_DATA_DIR;
  else process.env.REGIMEN_DATA_DIR = savedDataDir;
  savedDataDir = undefined;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-prune-"));
  tempDirs.push(dir);
  return dir;
}

/** Run `body` capturing everything written to stdout, restoring it after. */
function captureStdout(body: () => void): string {
  let out = "";
  const saved = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    body();
  } finally {
    process.stdout.write = saved;
  }
  return out;
}

/** Write a gemini project-level (`.gemini/settings.json`) nested hooks file. */
function writeGeminiHooks(workspace: string, leaves: LeafHook[]): string {
  const path = join(workspace, ".gemini", "settings.json");
  mkdirSync(join(workspace, ".gemini"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: leaves }] } }, null, 2)}\n`,
  );
  return path;
}

function geminiEntry(workspace: string): ManifestEntry {
  return {
    harness: "gemini",
    pillars: ["feedback", "enforcement", "guidance"],
    scope: `workspace:${workspace}`,
  };
}

function manifestWith(entries: ManifestEntry[], clonePath: string): Manifest {
  return {
    schemaVersion: 1,
    regimenVersion: "0.4.0",
    clonePath,
    loaderPath: `${clonePath}/packages/feedback/src/loader/run.ts`,
    installedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    entries,
  };
}

function readLeaves(path: string): LeafHook[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    hooks?: Record<string, { hooks: LeafHook[] }[]>;
  };
  return (parsed.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks);
}

test("removes a dead marked leaf whose script sits under the recorded clone path", () => {
  const workspace = tempDir();
  const recorded = "/recorded/regimen";
  const path = writeGeminiHooks(workspace, [
    {
      type: "command",
      command: `bun ${recorded}/packages/enforcement/examples/gate.ts`,
      _regimen: { v: 1, role: "gate", id: "rm-rf" },
    },
  ]);
  const manifest = manifestWith([geminiEntry(workspace)], recorded);

  const out = captureStdout(() =>
    pruneDeadHooks(manifest, "/current/regimen", false),
  );

  expect(out).toContain("removed dead gate leaf on PreToolUse");
  expect(out).toContain("rm-rf");
  expect(readLeaves(path)).toEqual([]);
});

test("reports but never removes a dead marked leaf outside every clone", () => {
  const workspace = tempDir();
  const path = writeGeminiHooks(workspace, [
    {
      type: "command",
      command: "bun /home/user/my-gates/my-gate.ts",
      _regimen: { v: 1, role: "gate", id: "mine" },
    },
  ]);
  const manifest = manifestWith([geminiEntry(workspace)], "/recorded/regimen");

  const out = captureStdout(() =>
    pruneDeadHooks(manifest, "/current/regimen", false),
  );

  expect(out.toLowerCase()).toContain("warning");
  expect(out).toContain("/home/user/my-gates/my-gate.ts");
  expect(out).not.toContain("removed dead");
  // The leaf is left in place untouched.
  expect(readLeaves(path)).toHaveLength(1);
});

test("leaves unmarked and live leaves alone", () => {
  const workspace = tempDir();
  const live = join(workspace, "live-capture.ts");
  writeFileSync(live, "// a real, present script\n");
  const path = writeGeminiHooks(workspace, [
    { type: "command", command: "user's own hook" },
    {
      type: "command",
      command: `bun ${live}`,
      _regimen: { v: 1, role: "capture" },
    },
  ]);
  const manifest = manifestWith([geminiEntry(workspace)], "/recorded/regimen");

  const out = captureStdout(() => pruneDeadHooks(manifest, live, false));

  expect(out).toBe("");
  expect(readLeaves(path).map((l) => l.command)).toEqual([
    "user's own hook",
    `bun ${live}`,
  ]);
});

test("--dry-run reports the removal but writes nothing", () => {
  const workspace = tempDir();
  const recorded = "/recorded/regimen";
  const path = writeGeminiHooks(workspace, [
    {
      type: "command",
      command: `bun ${recorded}/dead.ts`,
      _regimen: { v: 1, role: "gate", id: "d" },
    },
  ]);
  const manifest = manifestWith([geminiEntry(workspace)], recorded);

  const out = captureStdout(() =>
    pruneDeadHooks(manifest, "/current/regimen", true),
  );

  expect(out).toContain("would remove dead gate leaf on PreToolUse");
  // Nothing was written: the dead leaf is still there.
  expect(readLeaves(path)).toHaveLength(1);
});

test("a missing hooks file is a no-op, not an error", () => {
  const workspace = tempDir();
  const manifest = manifestWith([geminiEntry(workspace)], "/recorded/regimen");

  const out = captureStdout(() =>
    pruneDeadHooks(manifest, "/current/regimen", false),
  );

  expect(out).toBe("");
});

/** Instrument steps that all succeed without doing any real install work. */
function noopSteps(): InstrumentSteps {
  return {
    feedbackInstall: () => 0,
    enforcementInstall: () => 0,
    guidanceInstall: () => 0,
    feedbackUninstall: () => 0,
    enforcementUninstall: () => 0,
    guidanceUninstall: () => 0,
    selfLink: () => 0,
  };
}

/** Lifecycle deps with fixed stamps and a no-op daemon cycle. */
function noopLife(clonePath: string): LifecycleDeps {
  return {
    now: () => "2026-07-05T00:00:00.000Z",
    regimenVersion: () => "0.5.0",
    clonePath: () => clonePath,
    loaderPath: () => `${clonePath}/packages/feedback/src/loader/run.ts`,
    installScope: () => "config-home",
    installableHarnesses: () => [],
    cycleDaemon: () => 0,
  };
}

test("update prunes a dead leaf recorded in the manifest end to end", () => {
  const dataDirPath = tempDir();
  const workspace = tempDir();
  const recorded = "/recorded/regimen";
  process.env.REGIMEN_DATA_DIR = dataDirPath;

  const hooksPath = writeGeminiHooks(workspace, [
    {
      type: "command",
      command: `bun ${recorded}/packages/enforcement/examples/gate.ts`,
      _regimen: { v: 1, role: "gate", id: "stale" },
    },
  ]);
  writeManifest(
    manifestPath(dataDirPath),
    manifestWith([geminiEntry(workspace)], recorded),
  );

  const out = captureStdout(() =>
    update(["update"], noopSteps(), noopLife("/current/regimen")),
  );

  expect(out).toContain("removed dead gate leaf on PreToolUse");
  expect(readLeaves(hooksPath)).toEqual([]);
});
