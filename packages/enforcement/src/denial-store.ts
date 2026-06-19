/**
 * The store-write seam for the Enforcement instrument: how a discipline gate
 * records a gate.denial event WITHOUT importing any Feedback code.
 *
 * Enforcement is its own repo and cannot import Feedback's TypeScript modules,
 * so this module reimplements exactly what the published store-write contract
 * (Feedback's docs/store-write-contract.md) specifies: where the buffer
 * lives, the v1 gate.denial line shape, and the frozen trace_id derivation. It
 * writes one JSON line across the open-format buffer seam; Feedback's loader
 * drains that line into its store.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";

const APP_DIR_NAME = "regimen";

/** The agent harnesses the schema admits, as normalized identifiers. */
export const HARNESSES = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "opencode",
  "copilot",
] as const;
export type Harness = (typeof HARNESSES)[number];

/** Narrow an untrusted string to a known harness identifier, else undefined. */
export function asHarness(value: string): Harness | undefined {
  return HARNESSES.find((harness) => harness === value);
}

/** One v1 event in the append-only buffer. Matches Feedback's event schema. */
export interface RegimenEvent {
  schema_version: 1;
  timestamp: string;
  session_id: string;
  harness: Harness;
  model?: string;
  event_type: "gate.denial";
  trace_id: string;
  span_phase: "point";
  span_name: string;
  attributes: Record<string, string>;
}

/** The normalized inputs a gate hands over when it denies a tool call. */
export interface GateDenialInput {
  gate_id: string;
  session_id: string;
  harness: Harness;
  tool_name: string;
  tool_call_id: string;
  reason?: string;
  model?: string;
}

/**
 * The OTLP-native trace id (32 hex chars) for a session, frozen by the
 * store-write contract: the SHA-256 of the UTF-8 string "trace:" + session_id,
 * lowercase hex, truncated to the first 32 characters. Reproduced exactly so
 * Enforcement's denials land in the same trace as the session's capture events.
 */
function traceIdFor(sessionId: string): string {
  return createHash("sha256")
    .update(`trace:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Build a gate.denial v1 event per the store-write contract. Pure: the gate, at
 * its harness-specific edge, has already normalized its native hook payload into
 * these fields. Optional fields (model, reason) are omitted when undefined to
 * match the contract's line shape exactly.
 */
export function buildGateDenialLine(input: GateDenialInput): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    harness: input.harness,
    ...(input.model !== undefined ? { model: input.model } : {}),
    event_type: "gate.denial",
    trace_id: traceIdFor(input.session_id),
    span_phase: "point",
    span_name: `gate:${input.gate_id}`,
    attributes: {
      gate_id: input.gate_id,
      tool_name: input.tool_name,
      tool_call_id: input.tool_call_id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  };
}

/** Return env[key] if it is a non-empty string, otherwise undefined. */
function readEnv(
  env: Partial<NodeJS.ProcessEnv>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve the Regimen data directory from an env snapshot and a platform string,
 * exactly as the store-write contract documents Feedback's own resolution.
 * REGIMEN_DATA_DIR overrides every platform; otherwise it dispatches on the OS.
 * Pure: callers under test pass fixed inputs and assert the result.
 */
export function resolveDataDirFrom(
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
export function resolveDataDir(): string {
  return resolveDataDirFrom(process.env, process.platform);
}

/**
 * Append one already-built v1 gate.denial as a JSON line to
 * <dataDir>/buffer/current.jsonl, per the contract's append semantics: mkdir -p
 * the buffer directory first (it may not exist on a fresh install), then append
 * one newline-terminated line. The buffer is append-only, so this never rewrites
 * existing bytes and concurrent producers are safe.
 */
export function appendGateDenial(dataDir: string, event: RegimenEvent): void {
  const dir = join(dataDir, "buffer");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "current.jsonl"), `${JSON.stringify(event)}\n`);
}
