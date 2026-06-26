/**
 * The install lifecycle the unified `regimen` CLI owns (ADR-0012): writing the
 * install manifest on install/uninstall, `regimen update` re-resolving paths and
 * re-running the recorded installs, `install --all`/`--harnesses` looping the
 * per-harness install, and `regimen status` reading the manifest. Driven through
 * injected instrument steps and lifecycle deps so the manifest writes, the
 * per-harness re-installs, and the daemon cycle are asserted deterministically in
 * a per-test temp data dir, never standing up a real OS install. The harness is
 * targeted by `REGIMEN_HARNESS` (the env-driven way the facades resolve it), so
 * the test sets that env around each call and restores it after.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstrumentSteps,
  type LifecycleDeps,
  install,
  runCli,
  uninstall,
  update,
} from "../src/cli/index.ts";
import {
  type ManifestEntry,
  manifestPath,
  readManifest,
  writeManifest,
} from "../src/manifest.ts";

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

interface Call {
  readonly step: string;
  readonly harness?: string;
  readonly dataDir?: string;
}

/** A recording fake of the instrument steps; each call appends in order. */
function recordingSteps(calls: Call[]): InstrumentSteps {
  return {
    feedbackInstall: () => {
      calls.push({ step: "feedbackInstall", harness: harnessEnv() });
      return 0;
    },
    enforcementInstall: () => {
      calls.push({
        step: "enforcementInstall",
        harness: harnessEnv(),
      });
      return 0;
    },
    feedbackUninstall: () => {
      calls.push({ step: "feedbackUninstall", harness: harnessEnv() });
      return 0;
    },
    enforcementUninstall: () => {
      calls.push({ step: "enforcementUninstall", harness: harnessEnv() });
      return 0;
    },
    selfLink: (verb) => {
      calls.push({ step: `selfLink:${verb}` });
      return 0;
    },
  };
}

/** A recording fake of the lifecycle deps with fixed stamps. */
function lifecycleDeps(calls: Call[], overrides: Partial<LifecycleDeps> = {}) {
  const base: LifecycleDeps = {
    now: () => "2026-06-22T12:00:00.000Z",
    regimenVersion: () => "0.4.2",
    clonePath: () => "/clones/regimen",
    loaderPath: () => "/clones/regimen/packages/feedback/src/loader/run.ts",
    installScope: (harness) =>
      harness === "gemini" ? "workspace:/work/proj" : "config-home",
    installableHarnesses: () => ["codex", "claude", "copilot", "gemini"],
    cycleDaemon: (dir) => {
      calls.push({ step: "cycleDaemon", dataDir: dir });
      return 0;
    },
  };
  return { ...base, ...overrides };
}

function harnessEnv(): string | undefined {
  return process.env.REGIMEN_HARNESS;
}

const tempDirs: string[] = [];
const HARNESS_MARKERS = [
  "REGIMEN_HARNESS",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "GEMINI_CLI",
  "COPILOT_CLI",
];
const savedMarkers = new Map<string, string | undefined>();
let savedDataDir: string | undefined;

// The harness is resolved from the environment, so a controlled env is the
// faithful way to target a harness per test. Clear every CLI-set marker (and
// REGIMEN_HARNESS) up front so the ambient agent the suite runs inside never
// leaks a harness into a test that pins (or deliberately omits) its own.
beforeEach(() => {
  savedDataDir = process.env.REGIMEN_DATA_DIR;
  for (const marker of HARNESS_MARKERS) {
    savedMarkers.set(marker, process.env[marker]);
    delete process.env[marker];
  }
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.REGIMEN_DATA_DIR;
  else process.env.REGIMEN_DATA_DIR = savedDataDir;
  for (const [marker, value] of savedMarkers) {
    if (value === undefined) delete process.env[marker];
    else process.env[marker] = value;
  }
  savedMarkers.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-lifecycle-"));
  tempDirs.push(dir);
  process.env.REGIMEN_DATA_DIR = dir;
  return dir;
}

test("install writes a manifest entry for the resolved harness with config-home scope", () => {
  const dir = tempDataDir();
  process.env.REGIMEN_HARNESS = "codex";
  const calls: Call[] = [];
  const exit = install(
    ["install"],
    recordingSteps(calls),
    lifecycleDeps(calls),
  );
  expect(exit).toBe(0);
  const manifest = readManifest(manifestPath(dir));
  expect(manifest?.entries).toEqual([
    {
      harness: "codex",
      pillars: ["feedback", "enforcement"],
      scope: "config-home",
    },
  ]);
});

test("install --dry-run writes no manifest", () => {
  const dir = tempDataDir();
  process.env.REGIMEN_HARNESS = "codex";
  const calls: Call[] = [];
  const exit = install(
    ["install", "--dry-run"],
    recordingSteps(calls),
    lifecycleDeps(calls),
  );
  expect(exit).toBe(0);
  expect(readManifest(manifestPath(dir))).toBeUndefined();
});

test("uninstall removes the env-resolved harness from the manifest", () => {
  const dir = tempDataDir();
  process.env.REGIMEN_HARNESS = "codex";
  const calls: Call[] = [];
  install(["install"], recordingSteps(calls), lifecycleDeps(calls));
  uninstall(["uninstall"], recordingSteps(calls));
  expect(readManifest(manifestPath(dir))?.entries).toEqual([]);
});

test("update with no manifest falls back to a fresh install", () => {
  const dir = tempDataDir();
  process.env.REGIMEN_HARNESS = "codex";
  const calls: Call[] = [];
  const exit = update(["update"], recordingSteps(calls), lifecycleDeps(calls));
  expect(exit).toBe(0);
  expect(readManifest(manifestPath(dir))?.entries).toEqual([
    {
      harness: "codex",
      pillars: ["feedback", "enforcement"],
      scope: "config-home",
    },
  ]);
});

/** Write a manifest with the given entries and old stamps directly to the dir. */
function seedManifest(dir: string, entries: ManifestEntry[]): void {
  writeManifest(manifestPath(dir), {
    schemaVersion: 1,
    regimenVersion: "0.3.0",
    clonePath: "/old/regimen",
    loaderPath: "/old/regimen/packages/feedback/src/loader/run.ts",
    installedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    entries,
  });
}

test("update re-runs the install for each recorded entry, targeting each harness", () => {
  const dir = tempDataDir();
  delete process.env.REGIMEN_HARNESS;
  seedManifest(dir, [
    {
      harness: "codex",
      pillars: ["feedback", "enforcement"],
      scope: "config-home",
    },
    {
      harness: "gemini",
      pillars: ["feedback", "enforcement"],
      scope: "workspace:/work/proj",
    },
  ]);
  const calls: Call[] = [];
  const exit = update(["update"], recordingSteps(calls), lifecycleDeps(calls));
  expect(exit).toBe(0);
  const installed = calls
    .filter((c) => c.step === "feedbackInstall")
    .map((c) => c.harness);
  expect(installed).toEqual(["codex", "gemini"]);
});

test("update cycles the daemon so it runs the freshly-resolved loader path", () => {
  const dir = tempDataDir();
  seedManifest(dir, [
    { harness: "codex", pillars: ["feedback"], scope: "config-home" },
  ]);
  const calls: Call[] = [];
  update(["update"], recordingSteps(calls), lifecycleDeps(calls));
  expect(calls.some((c) => c.step === "cycleDaemon")).toBe(true);
});

test("install --all records every installable harness with its scope", () => {
  const dir = tempDataDir();
  delete process.env.REGIMEN_HARNESS;
  const calls: Call[] = [];
  const exit = install(
    ["install", "--all"],
    recordingSteps(calls),
    lifecycleDeps(calls),
  );
  expect(exit).toBe(0);
  const manifest = readManifest(manifestPath(dir));
  expect(manifest?.entries.map((e) => e.harness)).toEqual([
    "codex",
    "claude",
    "copilot",
    "gemini",
  ]);
  expect(manifest?.entries.find((e) => e.harness === "gemini")?.scope).toBe(
    "workspace:/work/proj",
  );
});

test("install --all prints the gemini per-workspace notice", () => {
  tempDataDir();
  delete process.env.REGIMEN_HARNESS;
  const calls: Call[] = [];
  const out = captureStdout(() => {
    install(["install", "--all"], recordingSteps(calls), lifecycleDeps(calls));
  });
  expect(out).toContain("gemini capture installs into the current workspace");
});

test("install with no resolvable harness records nothing", () => {
  const dir = tempDataDir();
  delete process.env.REGIMEN_HARNESS;
  const calls: Call[] = [];
  const exit = install(
    ["install"],
    recordingSteps(calls),
    lifecycleDeps(calls),
  );
  expect(exit).toBe(0);
  expect(readManifest(manifestPath(dir))).toBeUndefined();
});

test("install --harnesses records exactly the named subset", () => {
  const dir = tempDataDir();
  delete process.env.REGIMEN_HARNESS;
  const calls: Call[] = [];
  install(
    ["install", "--harnesses", "codex", "--harnesses", "claude"],
    recordingSteps(calls),
    lifecycleDeps(calls),
  );
  expect(
    readManifest(manifestPath(dir))?.entries.map((e) => e.harness),
  ).toEqual(["codex", "claude"]);
});

test("install --all targets each harness via REGIMEN_HARNESS in turn", () => {
  tempDataDir();
  delete process.env.REGIMEN_HARNESS;
  const calls: Call[] = [];
  install(["install", "--all"], recordingSteps(calls), lifecycleDeps(calls));
  expect(
    calls.filter((c) => c.step === "feedbackInstall").map((c) => c.harness),
  ).toEqual(["codex", "claude", "copilot", "gemini"]);
});

test("update restamps version and paths but preserves installedAt and entry scopes", () => {
  const dir = tempDataDir();
  seedManifest(dir, [
    {
      harness: "gemini",
      pillars: ["feedback", "enforcement"],
      scope: "workspace:/work/proj",
    },
  ]);
  const calls: Call[] = [];
  update(["update"], recordingSteps(calls), lifecycleDeps(calls));
  const manifest = readManifest(manifestPath(dir));
  expect(manifest?.regimenVersion).toBe("0.4.2");
  expect(manifest?.clonePath).toBe("/clones/regimen");
  expect(manifest?.loaderPath).toBe(
    "/clones/regimen/packages/feedback/src/loader/run.ts",
  );
  expect(manifest?.updatedAt).toBe("2026-06-22T12:00:00.000Z");
  expect(manifest?.installedAt).toBe("2026-06-01T00:00:00.000Z");
  expect(manifest?.entries).toEqual([
    {
      harness: "gemini",
      pillars: ["feedback", "enforcement"],
      scope: "workspace:/work/proj",
    },
  ]);
});

test("status renders the manifest version, entries with pillars and scope", async () => {
  const dir = tempDataDir();
  writeManifest(manifestPath(dir), {
    schemaVersion: 1,
    regimenVersion: "0.4.2",
    clonePath: "/clones/regimen",
    loaderPath: "/clones/regimen/packages/feedback/src/loader/run.ts",
    installedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    entries: [
      {
        harness: "gemini",
        pillars: ["feedback", "enforcement"],
        scope: "workspace:/work/proj",
      },
    ],
  });
  let exit: number | Promise<number> = 1;
  const out = captureStdout(() => {
    exit = runCli(["status"]);
  });
  expect(await exit).toBe(0);
  expect(out).toContain("0.4.2");
  expect(out).toContain("gemini");
  expect(out).toContain("workspace:/work/proj");
  expect(out).toContain("feedback, enforcement");
});

test("status with no manifest says nothing is installed yet", async () => {
  tempDataDir();
  let exit: number | Promise<number> = 1;
  const out = captureStdout(() => {
    exit = runCli(["status"]);
  });
  expect(await exit).toBe(0);
  expect(out.toLowerCase()).toContain("nothing installed");
});
