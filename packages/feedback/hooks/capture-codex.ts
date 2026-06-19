#!/usr/bin/env bun
/**
 * The Codex capture hook for the Feedback instrument.
 *
 * Mirrors hooks/capture.ts but stamps the Codex harness identifier on the
 * envelope. Reads a Codex hook payload from stdin and appends one envelope
 * JSON line to the buffer per ADR-0006.
 */
import { writeSessionStamp } from "../src/codex/session-stamp.ts";
import { bufferDir, dataDir } from "@regimen/shared";
import { isEnabled } from "../src/enabled-flag.ts";
import { readString } from "../src/envelope.ts";
import { appendEnvelope, recordError } from "./event-log.ts";

/**
 * On SessionStart, record the session id as live for its cwd, so the
 * in-session evidence skill can resolve "my session" without a Codex
 * session-id environment variable. Best effort: any failure is swallowed so
 * the stamp never blocks capture or surfaces to the agent.
 */
function stampIfSessionStart(payload: unknown, dir: string): void {
  if (typeof payload !== "object" || payload === null) return;
  const fields = payload as Record<string, unknown>;
  if (readString(fields, "hook_event_name") !== "SessionStart") return;
  const sessionId = readString(fields, "session_id");
  const cwd = readString(fields, "cwd");
  if (sessionId === undefined || cwd === undefined) return;
  writeSessionStamp({ dataDir: dir, harness: "codex", cwd, sessionId });
}

async function main(): Promise<void> {
  const dir = dataDir();
  if (!isEnabled(dir)) return;
  try {
    const raw = await Bun.stdin.text();
    const payload: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
    appendEnvelope("codex", payload, bufferDir(dir));
    stampIfSessionStart(payload, dir);
  } catch (err) {
    recordError(err);
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
