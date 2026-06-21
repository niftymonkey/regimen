#!/usr/bin/env bun
/**
 * The GitHub Copilot CLI capture hook for the Feedback instrument.
 *
 * Reads a Copilot CLI hook payload from stdin and appends one envelope JSON
 * line to the buffer per ADR-0006. The envelope wraps the raw harness payload
 * with the harness identifier and the time the hook ran; translation into the
 * canonical v1 event schema happens later in the loader, not in the hook, so
 * adding a new harness stays a one-file change. The hook exits 0
 * unconditionally and writes nothing to stdout, so a capture failure can never
 * block or interfere with the session.
 *
 * A registered live-capture translator for Copilot is deferred until the full
 * Copilot hook-event payload taxonomy is producer-confirmed; until then a
 * captured Copilot envelope quarantines (the designed fail-safe), while the
 * judge/assess path reads the transcript directly via the Copilot reader.
 */
import { bufferDir, dataDir } from "@regimen/shared";
import { isEnabled } from "../src/enabled-flag.ts";
import { appendEnvelope, recordError } from "./event-log.ts";

async function main(): Promise<void> {
  const dir = dataDir();
  if (!isEnabled(dir)) return;
  try {
    const raw = await Bun.stdin.text();
    const payload: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
    appendEnvelope("copilot", payload, bufferDir(dir));
  } catch (err) {
    recordError(err);
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
