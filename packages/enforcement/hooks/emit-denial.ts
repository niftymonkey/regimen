#!/usr/bin/env bun
/**
 * The gate-denial emitter for the Enforcement instrument.
 *
 * A discipline gate, on any harness, invokes this when it denies a tool call;
 * it records one gate.denial event across the published store-write seam
 * (Feedback's docs/store-write-contract.md) so the evidence layer sees it.
 * It is harness-agnostic: the gate, at its own harness-specific edge, normalizes
 * its native hook payload into the flags below. It exits 0 unconditionally and
 * writes nothing to stdout, so an emit failure can never break the gate's denial.
 *
 * Usage:
 *   emit-denial --gate <id> --session <id> --harness <id> \
 *     --tool <name> --tool-call-id <id> [--reason <text>] [--model <id>]
 *
 * A universal script gate that already has the harness's PreToolUse payload on
 * stdin can pass `--from-hook` instead of `--session`/`--tool`/`--tool-call-id`:
 * the emitter reads that payload and fills those (and `--model`) from it, so a
 * shell gate records a denial with one piped call. The fields it reads
 * (`session_id`, `tool_name`, `tool_use_id`, `model`) are the shape Claude and
 * Codex share. An explicit flag still wins over the payload, and a malformed
 * payload fails safe (the missing-flag guard below catches the empty fields).
 */
import { parseArgs } from "node:util";
import {
  appendGateDenial,
  asHarness,
  buildGateDenialLine,
  resolveDataDir,
} from "../src/denial-store.ts";

/**
 * Read a string field from an untrusted payload, or undefined when absent or
 * empty. Reimplemented here (not imported from Feedback) so Enforcement never
 * couples to the consumer it writes across the seam to.
 */
function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the hook payload on stdin, treating empty or malformed input as {}. */
async function readHookPayload(): Promise<Record<string, unknown>> {
  const raw = await Bun.stdin.text();
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  try {
    const { values } = parseArgs({
      options: {
        gate: { type: "string" },
        session: { type: "string" },
        harness: { type: "string" },
        tool: { type: "string" },
        "tool-call-id": { type: "string" },
        reason: { type: "string" },
        model: { type: "string" },
        "from-hook": { type: "boolean" },
      },
    });

    const payload = values["from-hook"] ? await readHookPayload() : {};
    const gate = values.gate;
    const session = values.session ?? readString(payload, "session_id");
    const tool = values.tool ?? readString(payload, "tool_name");
    const toolCallId =
      values["tool-call-id"] ?? readString(payload, "tool_use_id");
    const model = values.model ?? readString(payload, "model");
    const harness = asHarness(values.harness ?? "");

    const hasValue = (v: string | undefined): v is string =>
      v !== undefined && v.length > 0;
    if (
      !hasValue(gate) ||
      !hasValue(session) ||
      !hasValue(tool) ||
      !hasValue(toolCallId) ||
      harness === undefined
    ) {
      return;
    }

    appendGateDenial(
      resolveDataDir(),
      buildGateDenialLine({
        gate_id: gate,
        session_id: session,
        harness,
        tool_name: tool,
        tool_call_id: toolCallId,
        ...(values.reason !== undefined ? { reason: values.reason } : {}),
        ...(model !== undefined ? { model } : {}),
      }),
    );
  } catch {
    // A recording failure must never surface to the session or change the
    // gate's deny decision: swallow it and exit 0.
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
