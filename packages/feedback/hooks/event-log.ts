/**
 * Shared event-log core for the Feedback capture edge.
 *
 * The harness-agnostic primitives every event producer needs: the v1 event
 * shape, deterministic trace-id derivation, and the appends to the buffer.
 * Per ADR-0006 the buffer is `<bufferDir>/current.jsonl` for active appends,
 * plus zero or more `sealed-<rfc3339>.jsonl` segments rotated out by the
 * daemon. See docs/event-schema.md for the v1 event contract.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { bufferDir, dataDir } from "../src/data-dir.ts";
import { rollIfOversize } from "../src/rolling-log.ts";

export type SpanPhase = "start" | "end" | "point";

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

/** Narrow an untrusted string to a known harness identifier. */
export function asHarness(value: string): Harness | undefined {
  return HARNESSES.find((harness) => harness === value);
}

/** One event in the append-only buffer. Matches event.schema.json. */
export interface RegimenEvent {
  schema_version: 1;
  timestamp: string;
  session_id: string;
  harness: Harness;
  model?: string;
  /**
   * The working directory the harness session ran in, as the harness reported
   * it. A session-level anchor for which body of work a conversation belongs
   * to; the loader projects it onto the conversations rollup, never onto the
   * per-event row. Optional per "Honest over tidy": a harness that does not
   * expose a directory leaves it absent rather than fabricating one.
   */
  cwd?: string;
  event_type: string;
  trace_id: string;
  span_phase: SpanPhase;
  span_name: string;
  attributes: Record<string, string>;
}

/** A deterministic lowercase hex id of OTLP-native width derived from seed. */
function hexId(seed: string, length: number): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

/**
 * The OTLP-native trace id (32 hex chars) for a session. Derived from the
 * session id, so every event of one session shares a trace id and lands in
 * the same trace, whichever producer emitted it.
 */
export function traceIdFor(sessionId: string): string {
  return hexId(`trace:${sessionId}`, 32);
}

/**
 * Append one already-translated v1 event as a JSON line to
 * `<dir>/current.jsonl`. Used by producers that mint v1 events directly (an
 * external producer over the store-write contract, such as the denial emitter
 * in regimen-enforcement); the capture hook uses `appendEnvelope` instead.
 */
export function appendEvent(event: RegimenEvent, dir: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "current.jsonl"), `${JSON.stringify(event)}\n`);
}

/**
 * Append one envelope line to `<dir>/current.jsonl` per ADR-0006. The
 * envelope wraps the raw harness payload with the harness identifier and
 * the time the hook ran; the loader's translator turns each envelope into
 * a canonical v1 event.
 */
export function appendEnvelope(
  harness: string,
  payload: unknown,
  dir: string,
): void {
  const envelope = {
    harness,
    captured_at: new Date().toISOString(),
    payload,
  };
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "current.jsonl"), `${JSON.stringify(envelope)}\n`);
}

/**
 * The buffer's segment files in `dir`, in the chronological read order a
 * consumer should iterate: sealed segments oldest-first, then `current.jsonl`
 * last so a continuous reader follows the still-growing active segment.
 */
const SEALED_PATTERN = /^sealed-.*\.jsonl$/;

/**
 * Whether `pathOrName` names a sealed segment (the `sealed-<rfc3339>.jsonl`
 * convention), as opposed to the active `current.jsonl`. Accepts a bare
 * filename or a full path.
 */
export function isSealedSegment(pathOrName: string): boolean {
  return SEALED_PATTERN.test(basename(pathOrName));
}

export function listSegments(dir: string = bufferDir(dataDir())): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sealed = names.filter((name) => SEALED_PATTERN.test(name)).sort();
  const segments = sealed.map((name) => join(dir, name));
  if (names.includes("current.jsonl")) {
    segments.push(join(dir, "current.jsonl"));
  }
  return segments;
}

/** Rolled copies of `capture-errors.log` to retain past the active file. */
const CAPTURE_ERROR_LOG_KEEP = 3;

/**
 * The size cap for `capture-errors.log`: `REGIMEN_CAPTURE_LOG_MAX_BYTES` when
 * that env var holds a positive number, else 1 MB.
 */
function captureErrorLogMaxBytes(): number {
  const env = Number(process.env.REGIMEN_CAPTURE_LOG_MAX_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 1_000_000;
}

/**
 * Append a failure to the error log, swallowing any further error so a
 * capture failure can never surface to the session. The log is rolled at a
 * size cap before each append so it stays bounded over a long-running
 * install, the same hygiene the buffer and `daemon.log` already get.
 */
export function recordError(err: unknown): void {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "capture-errors.log");
    rollIfOversize(path, {
      maxBytes: captureErrorLogMaxBytes(),
      keep: CAPTURE_ERROR_LOG_KEEP,
    });
    appendFileSync(path, `${new Date().toISOString()} ${String(err)}\n`);
  } catch {
    // A failure to record the failure must still never surface.
  }
}

/** The normalized inputs a gate hands over when it denies a tool call. */
export interface GateDenial {
  /** Stable identifier of the gate that denied, e.g. "rm-rf-guard". */
  gate_id: string;
  session_id: string;
  harness: Harness;
  /** The tool whose call was denied, e.g. "Bash". */
  tool_name: string;
  /** Harness-native id of the denied call, to correlate it with its tool.pre. */
  tool_call_id: string;
  /** Why the gate denied the call. */
  reason?: string;
  /** The model active on the denied turn, when the gate knows it. */
  model?: string;
}

/**
 * Build a gate.denial event from a gate's normalized denial inputs. The
 * gate, at the harness-specific edge, has already normalized its native hook
 * payload into these fields; this builder is harness-agnostic.
 */
export function buildGateDenialEvent(denial: GateDenial): RegimenEvent {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    session_id: denial.session_id,
    harness: denial.harness,
    ...(denial.model !== undefined ? { model: denial.model } : {}),
    event_type: "gate.denial",
    trace_id: traceIdFor(denial.session_id),
    span_phase: "point",
    span_name: `gate:${denial.gate_id}`,
    attributes: {
      gate_id: denial.gate_id,
      tool_name: denial.tool_name,
      tool_call_id: denial.tool_call_id,
      ...(denial.reason !== undefined ? { reason: denial.reason } : {}),
    },
  };
}
