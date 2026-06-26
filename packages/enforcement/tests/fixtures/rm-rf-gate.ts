#!/usr/bin/env bun
/**
 * A WIRING TEST FIXTURE and documentation exemplar: the shape an authored
 * discipline gate takes, harness-agnostic by construction. Enforcement ships NO
 * gate catalog; the engineer's own gate is authored on demand by the
 * `regimen-enforcement` skill. This file exists ONLY so the gate-wiring tests
 * have a real body to merge onto a harness's pre-tool event, and so a reader can
 * see what an authored `bun` gate looks like. It is not installed as product.
 *
 * A minimal, illustrative PreToolUse hook. It denies a Bash tool call that runs
 * a recursive, forced `rm`. It exists to show the pattern any authored gate
 * follows.
 *
 * The deny shape Claude and Codex share is `hookSpecificOutput.permissionDecision:
 * "deny"`, so one gate body serves both: the rule and the deny live in this
 * portable body. The harness-specific work (reading the PreToolUse payload
 * shape, emitting the deny decision) lives here, at the gate edge.
 *
 * Honest reliability: a PreToolUse hook is a guardrail, not a hard boundary. On
 * Codex it does not intercept every unified_exec shell path, so a denied
 * command can still reach the shell on builds where that path bypasses the
 * hook. Codex's dedicated PermissionRequest hook is the stronger enforcement
 * surface, deferred to a later phase.
 */

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
 * security control. The recursive/forced check is scoped to each `rm`
 * invocation's OWN flags so a `-rf` carried by an unrelated command segment (a
 * `tar -rf`, say) does not make a harmless `rm` read as recursive-forced; a
 * command is denied only when one of its rm invocations is itself recursive and
 * forced.
 */
function isRecursiveForcedRm(command: string): boolean {
  return splitCommandSegments(command).some(isRecursiveForcedRmSegment);
}

/**
 * Split a command line into the segments separated by the shell operators that
 * end one command and begin another (`&&`, `||`, `;`, `|`, `&`, and a newline),
 * so each rm invocation is inspected with only its own flags, not flags from a
 * neighboring command.
 */
function splitCommandSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|&\n]/);
}

/** Whether one command segment is an `rm` invocation that is recursive and forced. */
function isRecursiveForcedRmSegment(segment: string): boolean {
  if (!/\brm\b/.test(segment)) return false;
  // Collect only genuine short-flag clusters (a single leading dash at a word
  // boundary), so the letters of a long flag like `--force` are not read as
  // short flags. Long flags are matched explicitly below.
  const shortFlags = Array.from(segment.matchAll(/(?:^|\s)-([a-zA-Z]+)/g))
    .map((match) => match[1])
    .join("");
  // The recursive flag has two spellings, `-r` and `-R`, both equally
  // destructive, so it is matched case-insensitively. The force flag is only
  // lowercase `-f` (rm has no `-F`), so it stays a literal lowercase check.
  const recursive = /r/i.test(shortFlags) || /--recursive\b/.test(segment);
  const forced = shortFlags.includes("f") || /--force\b/.test(segment);
  return recursive && forced;
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const payload = asRecord(parsePayload(raw));

  const toolName = readString(payload, "tool_name");
  const command = readString(asRecord(payload.tool_input), "command");
  if (toolName !== "Bash" || !isRecursiveForcedRm(command)) return;

  // Block unconditionally. The deny decision is the gate's load-bearing output.
  // Await the write so the decision is flushed before process.exit, which would
  // otherwise risk truncating the gate's only output to the harness.
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
