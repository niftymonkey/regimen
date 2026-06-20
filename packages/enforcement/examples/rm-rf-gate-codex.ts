#!/usr/bin/env bun
/**
 * The Codex port of the reference rm-rf discipline gate for the Enforcement
 * instrument.
 *
 * A minimal, illustrative Codex PreToolUse hook. It denies a Bash tool call
 * that runs a recursive, forced `rm`, and records the denial as a gate.denial
 * event. It is the worked Phase 1 guardrail: highest signal for the least
 * risk (a recursive forced rm is unambiguously destructive and rarely a false
 * positive). Like the Claude gate it ports, it is deliberately NOT registered
 * as a live hook; the trial config wires it as a user-level Codex PreToolUse
 * hook.
 *
 * Honest reliability: a Codex PreToolUse hook is a guardrail, not a hard
 * boundary. It does not intercept every unified_exec shell path, so a denied
 * command can still reach the shell on builds where that path bypasses the
 * hook. Codex's dedicated PermissionRequest hook
 * (`decision.behavior: "allow" | "deny"`) is the stronger enforcement surface,
 * deferred to a later phase.
 *
 * The harness-specific work (reading Codex's PreToolUse payload shape, emitting
 * Codex's deny decision) lives here, at the gate edge; the emit-denial emitter
 * stays harness-agnostic. Codex's deny shape is identical to Claude's
 * (`hookSpecificOutput.permissionDecision: "deny"`), so this is a near-trivial
 * port of examples/rm-rf-gate.ts: the denial logic matches apart from the
 * harness identifier, plus three robustness fixes the Claude original still
 * lacks (single-dash short-flag matching so `--force` alone is not read as
 * recursive, a guarded stdin parse that fails open, and an awaited deny flush).
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

  // Record the denial as telemetry, then deny the call to the harness.
  spawnSync("bun", [
    EMITTER,
    "--gate",
    GATE_ID,
    "--session",
    readString(payload, "session_id"),
    "--harness",
    "codex",
    "--tool",
    toolName,
    "--tool-call-id",
    readString(payload, "tool_use_id"),
    "--reason",
    REASON,
  ]);

  // Await the write so the deny decision is flushed before process.exit, which
  // would otherwise risk truncating the gate's only output to the harness.
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
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
