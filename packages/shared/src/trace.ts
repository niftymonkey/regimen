/**
 * Deterministic OTLP-native trace-id derivation. Pure computation, shared
 * across every producer so the same session lands in the same trace whichever
 * instrument emitted the event. Frozen by the store-write contract.
 */
import { createHash } from "node:crypto";

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
