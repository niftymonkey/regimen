/**
 * The Regimen data directory: where the buffer lives and where the SQLite
 * store lives. ADR-0006 specifies "a Regimen-owned data directory, resolved
 * per OS via the runtime's standard user-data-dir API," so this module
 * dispatches on the OS at runtime. `REGIMEN_DATA_DIR` overrides the
 * platform default; tests rely on it to point Regimen at a temp directory.
 *
 * Pure computation over an injected env and platform (plus the one env read in
 * `dataDir`), so it is a category-1 shared leaf both Feedback and Enforcement
 * import and the bridge reuses for its own path helpers.
 */
import {
  join as joinPath,
  posix as pathPosix,
  win32 as pathWin32,
} from "node:path";

const APP_DIR_NAME = "regimen";

/** Return env[key] if it is a non-empty string, otherwise undefined. */
function readEnv(
  env: Partial<NodeJS.ProcessEnv>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve the data directory from an env snapshot and a platform string.
 * Pure: takes everything it needs as arguments, so callers under test can
 * pass fixed inputs and assert the result without mocking `process`.
 */
export function resolveDataDir(
  env: Partial<NodeJS.ProcessEnv>,
  platform: string,
): string {
  const override = readEnv(env, "REGIMEN_DATA_DIR");
  if (override !== undefined) return override;

  if (platform === "linux") {
    const xdg = readEnv(env, "XDG_DATA_HOME");
    if (xdg !== undefined) return pathPosix.join(xdg, APP_DIR_NAME);
    const home = readEnv(env, "HOME");
    if (home !== undefined) {
      return pathPosix.join(home, ".local", "share", APP_DIR_NAME);
    }
  }
  if (platform === "darwin") {
    const home = readEnv(env, "HOME");
    if (home !== undefined) {
      return pathPosix.join(
        home,
        "Library",
        "Application Support",
        APP_DIR_NAME,
      );
    }
  }
  if (platform === "win32") {
    const appdata = readEnv(env, "APPDATA");
    if (appdata !== undefined) return pathWin32.join(appdata, APP_DIR_NAME);
  }
  throw new Error(
    `Regimen cannot resolve a data directory on platform "${platform}" with the given environment. Set REGIMEN_DATA_DIR to override.`,
  );
}

/** The data directory for the running process. */
export function dataDir(): string {
  return resolveDataDir(process.env, process.platform);
}

/**
 * The buffer directory: where the capture hook appends envelopes and the
 * loader reads segments. Lives under the data directory so a buffer-only
 * reset (`feedback purge`) does not touch the SQLite store.
 */
export function bufferDir(dir: string): string {
  return joinPath(dir, "buffer");
}
