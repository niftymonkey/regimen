/**
 * The install manifest: the one record of what `regimen install` placed on a
 * machine, persisted at `<dataDir>/install-manifest.json`. ADR-0012 makes the
 * install knowable so `regimen update` can re-resolve and re-place every
 * recorded harness, including Gemini's per-workspace installs (ADR-0011), which
 * is why each entry carries its install `scope`.
 *
 * Pure where it can be: `recordInstall` and `recordUninstall` are folds over a
 * manifest value taking the timestamp and version stamp as injected inputs, so
 * tests are deterministic. The only I/O is the filesystem seam at the manifest
 * path, substituted by a temp directory in tests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MANIFEST_FILENAME = "install-manifest.json";

const SCHEMA_VERSION = 1;

/** One installed-harness record: its pillars and where the install landed. */
export type ManifestEntry = {
  harness: string;
  pillars: string[];
  scope: string;
};

/** The persisted install manifest. */
export type Manifest = {
  schemaVersion: number;
  regimenVersion: string;
  clonePath: string;
  loaderPath: string;
  installedAt: string;
  updatedAt: string;
  entries: ManifestEntry[];
};

/** The injected stamps a fresh install records and an update restamps. */
export type InstallMeta = {
  now: string;
  regimenVersion: string;
  clonePath: string;
  loaderPath: string;
};

/** The manifest file path under a resolved data directory. */
export function manifestPath(dataDir: string): string {
  return join(dataDir, MANIFEST_FILENAME);
}

/** Parse the manifest at the path, or undefined when the file is absent. */
export function readManifest(manifestPath: string): Manifest | undefined {
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

/** Persist the manifest, creating the parent directory as needed. */
export function writeManifest(manifestPath: string, manifest: Manifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Upsert a per-harness entry and restamp, creating a fresh manifest if absent. */
export function recordInstall(
  manifest: Manifest | undefined,
  entry: ManifestEntry,
  meta: InstallMeta,
): Manifest {
  if (manifest === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,
      regimenVersion: meta.regimenVersion,
      clonePath: meta.clonePath,
      loaderPath: meta.loaderPath,
      installedAt: meta.now,
      updatedAt: meta.now,
      entries: [entry],
    };
  }
  const kept = manifest.entries.filter(
    (existing) =>
      existing.harness !== entry.harness || existing.scope !== entry.scope,
  );
  return {
    ...manifest,
    updatedAt: meta.now,
    entries: [...kept, entry],
  };
}

/** Remove the entry/entries matching the harness (and scope, when given). */
export function recordUninstall(
  manifest: Manifest,
  harness: string,
  scope?: string,
): Manifest {
  const entries = manifest.entries.filter(
    (entry) =>
      entry.harness !== harness ||
      (scope !== undefined && entry.scope !== scope),
  );
  return { ...manifest, entries };
}
