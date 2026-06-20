#!/usr/bin/env bun
/**
 * A reference discipline gate for the Enforcement instrument, harness-agnostic
 * by construction.
 *
 * A minimal, illustrative PreToolUse hook. It denies a Bash tool call that runs
 * a recursive, forced `rm`, and records the denial as a gate.denial event. It
 * exists to show the pattern any discipline gate follows to make its denials
 * observable, and as the fixture the emitter's integration test exercises. It
 * is deliberately NOT registered as a live hook; the trial config wires it as a
 * user-level PreToolUse hook.
 *
 * The deny shape Claude and Codex share is `hookSpecificOutput.permissionDecision:
 * "deny"`, so one gate body serves both: the rule and the deny live in this
 * portable body. The gate BLOCKS unconditionally, then records the denial only
 * when the harness is known: the harness label is the value the installer baked
 * into REGIMEN_HARNESS, with no hardcoded fallback, so an unset harness skips
 * the telemetry rather than stamping a wrong one. The harness-specific work
 * (reading the PreToolUse payload shape, emitting the deny decision) lives here,
 * at the gate edge; the emit-denial emitter stays harness-agnostic. A gate in
 * another language does the same by running the emitter as a subprocess.
 *
 * Honest reliability: a PreToolUse hook is a guardrail, not a hard boundary. On
 * Codex it does not intercept every unified_exec shell path, so a denied
 * command can still reach the shell on builds where that path bypasses the
 * hook. Codex's dedicated PermissionRequest hook is the stronger enforcement
 * surface, deferred to a later phase.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const GATE_ID = "rm-rf-guard";
const EMITTER = join(import.meta.dir, "..", "hooks", "emit-denial.ts");
const REASON = "recursive forced rm denied by the rm-rf-guard discipline gate";

/** Coerce an untrusted value to a record for safe field reads. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Read a string field from an untrusted payload, empty when absent. */
function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/**
 * Parse the hook's stdin JSON, treating empty or malformed input as an empty
 * payload. A gate must never crash the session on bad input, so a parse
 * failure fails open: the gate reads no tool call and denies nothing.
 */
function parsePayload(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Whether a Bash command runs a recursive, forced rm. Intentionally simple:
 * this gate is a reference example of the denial pattern, not a hardened
 * security control.
 */
function isRecursiveForcedRm(command: string): boolean {
  if (!/\brm\b/.test(command)) return false;
  // Collect only genuine short-flag clusters (a single leading dash at a word
  // boundary), so the letters of a long flag like `--force` are not read as
  // short flags. Long flags are matched explicitly below.
  const shortFlags = Array.from(command.matchAll(/(?:^|\s)-([a-zA-Z]+)/g))
    .map((match) => match[1])
    .join("");
  // The recursive flag has two spellings, `-r` and `-R`, both equally
  // destructive, so it is matched case-insensitively. The force flag is only
  // lowercase `-f` (rm has no `-F`), so it stays a literal lowercase check.
  const recursive = /r/i.test(shortFlags) || /--recursive\b/.test(command);
  const forced = shortFlags.includes("f") || /--force\b/.test(command);
  return recursive && forced;
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const payload = asRecord(parsePayload(raw));

  const toolName = readString(payload, "tool_name");
  const command = readString(asRecord(payload.tool_input), "command");
  if (toolName !== "Bash" || !isRecursiveForcedRm(command)) return;

  // Block unconditionally. The deny decision is the gate's load-bearing output,
  // so it is written first and always, independent of telemetry. Await the write
  // so the decision is flushed before process.exit, which would otherwise risk
  // truncating the gate's only output to the harness.
  await Bun.write(
    Bun.stdout,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: REASON,
      },
    }),
  );

  // Record the denial as telemetry only when the harness is known. The harness
  // is the value the installer baked into REGIMEN_HARNESS; with none present the
  // gate still blocks but skips the emit rather than stamping a wrong harness.
  const harness = process.env.REGIMEN_HARNESS;
  if (typeof harness !== "string" || harness.length === 0) return;
  spawnSync("bun", [
    EMITTER,
    "--gate",
    GATE_ID,
    "--session",
    readString(payload, "session_id"),
    "--harness",
    harness,
    "--tool",
    toolName,
    "--tool-call-id",
    readString(payload, "tool_use_id"),
    "--reason",
    REASON,
  ]);
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
