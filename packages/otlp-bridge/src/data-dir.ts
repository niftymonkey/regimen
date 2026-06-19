/**
 * Resolving the Regimen data directory the Feedback store lives in.
 *
 * The bridge reads `feedback.db` from the same OS-resolved directory the
 * loader writes it to (ADR-0006). This mirrors regimen-feedback's resolution
 * so the two agree without a cross-repo code dependency. `REGIMEN_DATA_DIR`
 * overrides the platform default; tests use it to point at a temp directory.
 *
 * The bridge keeps its own watermark state under a `bridge/` subdirectory of
 * the same data directory, so it never writes `feedback.db` or the buffer.
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
 * Pure: callers under test pass fixed inputs and assert the result.
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
    `Regimen cannot resolve a data directory on platform "${platform}". Set REGIMEN_DATA_DIR to override.`,
  );
}

/** The data directory for the running process. */
export function dataDir(): string {
  return resolveDataDir(process.env, process.platform);
}

/** The Feedback SQLite store the bridge reads. */
export function feedbackDbPath(dir: string): string {
  return joinPath(dir, "feedback.db");
}

/** The bridge's own watermark file, under a `bridge/` subdirectory. */
export function watermarkPath(dir: string): string {
  return joinPath(dir, "bridge", "watermarks.json");
}

/** The bridge's own operational log, which it owns and size-bounds itself. */
export function bridgeLogPath(dir: string): string {
  return joinPath(dir, "bridge.log");
}
