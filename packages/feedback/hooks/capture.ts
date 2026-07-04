#!/usr/bin/env bun
/**
 * The Claude Code capture hook for the Feedback instrument.
 *
 * Reads a Claude Code hook payload from stdin and appends one envelope JSON
 * line to the buffer per ADR-0006. The envelope wraps the raw harness payload
 * with the harness identifier and the time the hook ran; translation into the
 * canonical v1 event schema happens later in the loader, not in the hook, so
 * adding a new harness stays a one-file change.
 *
 * On SessionStart it also emits the backlog banner to stdout, which Claude Code
 * injects as session context: one terse line naming how many conversations
 * await assessment. This is the ONLY event that writes stdout, and the banner
 * degrades to silence on any error, so a capture or banner failure can never
 * block or interfere with the session. The hook exits 0 unconditionally.
 */
import { bufferDir, dataDir } from "@regimen/shared";
import { backlogBanner } from "../src/backlog-banner.ts";
import { isEnabled } from "../src/enabled-flag.ts";
import { readString } from "../src/envelope.ts";
import { appendEnvelope, recordError } from "./event-log.ts";

/**
 * On SessionStart, print the backlog banner to stdout for Claude Code to inject
 * as context. Best effort: the banner itself never throws (it returns null on
 * any failure and on a zero backlog), and this stays a no-op on every other
 * event so capture remains stdout-silent outside session start.
 */
function emitBannerIfSessionStart(payload: unknown, dir: string): void {
  if (typeof payload !== "object" || payload === null) return;
  const fields = payload as Record<string, unknown>;
  if (readString(fields, "hook_event_name") !== "SessionStart") return;
  const banner = backlogBanner({ dataDir: dir });
  if (banner !== null) process.stdout.write(`${banner}\n`);
}

async function main(): Promise<void> {
  const dir = dataDir();
  if (!isEnabled(dir)) return;
  try {
    const raw = await Bun.stdin.text();
    const payload: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
    appendEnvelope("claude", payload, bufferDir(dir));
    emitBannerIfSessionStart(payload, dir);
  } catch (err) {
    recordError(err);
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
