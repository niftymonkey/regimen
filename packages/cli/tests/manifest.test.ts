/**
 * The install manifest, the CLI's record of what `regimen install` placed on a
 * machine. Asserts the path derivation, the undefined-on-absent read, a full
 * write/read round-trip including the load-bearing `scope` field (both
 * `config-home` and `workspace:<path>`), the file-format convention, the upsert
 * (same harness+scope replaces, else appends), the fresh-manifest creation, and
 * the uninstall removal. Timestamps and the version stamp are injected, so the
 * folds are deterministic; the filesystem seam is a per-test temp directory.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Manifest,
  type ManifestEntry,
  manifestPath,
  readManifest,
  recordInstall,
  recordUninstall,
  writeManifest,
} from "../src/manifest.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifestPath resolves to install-manifest.json under the data dir", () => {
  expect(manifestPath("/data/regimen")).toBe(
    join("/data/regimen", "install-manifest.json"),
  );
});

test("readManifest returns undefined when the file is absent", () => {
  const path = manifestPath(tempDir());
  expect(readManifest(path)).toBeUndefined();
});

const sampleManifest: Manifest = {
  schemaVersion: 1,
  regimenVersion: "0.4.2",
  clonePath: "/clones/regimen",
  loaderPath: "/clones/regimen/packages/cli/src/loader.ts",
  installedAt: "2026-06-22T10:00:00.000Z",
  updatedAt: "2026-06-22T10:00:00.000Z",
  entries: [
    {
      harness: "claude",
      pillars: ["feedback", "enforcement"],
      scope: "config-home",
    },
  ],
};

test("writeManifest then readManifest round-trips the manifest including scope", () => {
  const path = manifestPath(tempDir());
  writeManifest(path, sampleManifest);
  expect(readManifest(path)).toEqual(sampleManifest);
});

test("writeManifest persists pretty-printed JSON with a trailing newline", () => {
  const path = manifestPath(tempDir());
  writeManifest(path, sampleManifest);
  expect(readFileSync(path, "utf8")).toBe(
    `${JSON.stringify(sampleManifest, null, 2)}\n`,
  );
});

const freshMeta = {
  now: "2026-06-22T12:00:00.000Z",
  regimenVersion: "0.4.2",
  clonePath: "/clones/regimen",
  loaderPath: "/clones/regimen/packages/cli/src/loader.ts",
};

const claudeEntry: ManifestEntry = {
  harness: "claude",
  pillars: ["feedback", "enforcement"],
  scope: "config-home",
};

test("recordInstall on undefined creates a fresh manifest stamped from meta", () => {
  const result = recordInstall(undefined, claudeEntry, freshMeta);
  expect(result).toEqual({
    schemaVersion: 1,
    regimenVersion: "0.4.2",
    clonePath: "/clones/regimen",
    loaderPath: "/clones/regimen/packages/cli/src/loader.ts",
    installedAt: "2026-06-22T12:00:00.000Z",
    updatedAt: "2026-06-22T12:00:00.000Z",
    entries: [claudeEntry],
  });
});

const codexEntry: ManifestEntry = {
  harness: "codex",
  pillars: ["feedback"],
  scope: "config-home",
};

const updateMeta = {
  now: "2026-06-23T09:30:00.000Z",
  regimenVersion: "0.5.0",
  clonePath: "/clones/regimen-moved",
  loaderPath: "/clones/regimen-moved/packages/cli/src/loader.ts",
};

test("recordInstall appends a new harness and restamps updatedAt, keeping installedAt", () => {
  const base = recordInstall(undefined, claudeEntry, freshMeta);
  const result = recordInstall(base, codexEntry, updateMeta);
  expect(result.entries).toEqual([claudeEntry, codexEntry]);
  expect(result.installedAt).toBe("2026-06-22T12:00:00.000Z");
  expect(result.updatedAt).toBe("2026-06-23T09:30:00.000Z");
});

test("recordInstall replaces the entry for the same harness and scope", () => {
  const base = recordInstall(undefined, claudeEntry, freshMeta);
  const reinstalled: ManifestEntry = {
    harness: "claude",
    pillars: ["feedback", "enforcement", "guidance"],
    scope: "config-home",
  };
  const result = recordInstall(base, reinstalled, updateMeta);
  expect(result.entries).toEqual([reinstalled]);
});

const geminiWorkspaceEntry: ManifestEntry = {
  harness: "gemini",
  pillars: ["feedback", "enforcement"],
  scope: "workspace:/home/dev/project-a",
};

test("recordInstall keeps same-harness entries with different scopes distinct", () => {
  const geminiConfigHome: ManifestEntry = {
    harness: "gemini",
    pillars: ["feedback"],
    scope: "config-home",
  };
  const base = recordInstall(undefined, geminiConfigHome, freshMeta);
  const result = recordInstall(base, geminiWorkspaceEntry, updateMeta);
  expect(result.entries).toEqual([geminiConfigHome, geminiWorkspaceEntry]);
});

test("a workspace-scoped install round-trips through write and read", () => {
  const path = manifestPath(tempDir());
  const manifest = recordInstall(undefined, geminiWorkspaceEntry, freshMeta);
  writeManifest(path, manifest);
  expect(readManifest(path)).toEqual(manifest);
  expect(readManifest(path)?.entries[0]?.scope).toBe(
    "workspace:/home/dev/project-a",
  );
});

test("recordUninstall without a scope removes every entry for the harness", () => {
  const withClaude = recordInstall(undefined, claudeEntry, freshMeta);
  const withGemini = recordInstall(
    withClaude,
    geminiWorkspaceEntry,
    updateMeta,
  );
  const withGeminiConfigHome = recordInstall(
    withGemini,
    { harness: "gemini", pillars: ["feedback"], scope: "config-home" },
    updateMeta,
  );
  const result = recordUninstall(withGeminiConfigHome, "gemini");
  expect(result.entries).toEqual([claudeEntry]);
});

test("recordUninstall with a scope removes only the matching workspace entry", () => {
  const geminiConfigHome: ManifestEntry = {
    harness: "gemini",
    pillars: ["feedback"],
    scope: "config-home",
  };
  const base = recordInstall(undefined, geminiConfigHome, freshMeta);
  const withWorkspace = recordInstall(base, geminiWorkspaceEntry, updateMeta);
  const result = recordUninstall(
    withWorkspace,
    "gemini",
    "workspace:/home/dev/project-a",
  );
  expect(result.entries).toEqual([geminiConfigHome]);
});

test("recordUninstall removing the last entry leaves an empty-entries manifest", () => {
  const base = recordInstall(undefined, claudeEntry, freshMeta);
  const result = recordUninstall(base, "claude");
  expect(result.entries).toEqual([]);
  expect(result.installedAt).toBe(base.installedAt);
  expect(result.regimenVersion).toBe(base.regimenVersion);
});
