/**
 * The golden set: a named local list of reference session ids with optional
 * coarse invariant expectations, persisted in the Regimen config home as
 * `golden.json`. It is the standing input to the judge calibration harness, so a
 * regression run can default to a curated reference set rather than an ad-hoc
 * `--sessions` list. The file is deliberately a sibling of the config-home env
 * file (a different branch owns `env`), never the same name.
 *
 * Pure filesystem I/O over an injected config directory: read returns undefined
 * when the file is absent (the harness then requires `--sessions`), and a
 * malformed file is a loud parse error, never a silent empty set.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One reference session in the golden set: its id and optional coarse invariants. */
export interface GoldenEntry {
  readonly sessionId: string;
  readonly expect?: {
    readonly outcome?: string;
    readonly engagement?: string;
  };
}

/** The golden file path under a config directory. */
export function goldenPath(configDir: string): string {
  return join(configDir, "golden.json");
}

/**
 * Read the golden set, or undefined when no golden file exists. Throws a clear
 * error on a malformed file so a broken golden set never reads as an empty one.
 */
export function readGolden(configDir: string): GoldenEntry[] | undefined {
  const path = goldenPath(configDir);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `the golden set at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `the golden set at ${path} must be a JSON array of entries`,
    );
  }
  return parsed.map((entry, index) => parseEntry(entry, index, path));
}

/** Parse and validate one raw golden entry, failing loudly on a bad shape. */
function parseEntry(raw: unknown, index: number, path: string): GoldenEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `the golden set at ${path} has a non-object entry at index ${index}`,
    );
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    throw new Error(
      `the golden set at ${path} has an entry without a sessionId at index ${index}`,
    );
  }
  const entry: GoldenEntry = { sessionId: record.sessionId };
  if (record.expect === undefined) return entry;
  if (typeof record.expect !== "object" || record.expect === null) {
    throw new Error(
      `the golden set at ${path} has a non-object expect at index ${index}`,
    );
  }
  const expectRaw = record.expect as Record<string, unknown>;
  const expect: { outcome?: string; engagement?: string } = {};
  if (typeof expectRaw.outcome === "string") expect.outcome = expectRaw.outcome;
  if (typeof expectRaw.engagement === "string") {
    expect.engagement = expectRaw.engagement;
  }
  return { ...entry, expect };
}

/** Write the golden set, creating the config directory if needed. */
export function writeGolden(
  configDir: string,
  entries: ReadonlyArray<GoldenEntry>,
): void {
  const path = goldenPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
}
