/**
 * Canonical JSON serialization and the event_hash primitive.
 *
 * The loader uses event_hash as the PRIMARY KEY of the events table, with
 * INSERT OR IGNORE absorbing every replay path (restart re-read, racing
 * subprocess across a rotation, malformed-line retry). For that to work, the
 * hash must be deterministic across runs and processes: the same canonical
 * v1 event always produces the same 32-byte digest, regardless of key order
 * in the source JSON or whitespace in the input line. ADR-0006 specifies
 * sha256 over the canonical event; this module is the canonical bit.
 */
import { createHash } from "node:crypto";

/**
 * Canonical JSON string for a value: lexically-sorted object keys at every
 * level, no whitespace, the same number/string/null/boolean handling as
 * JSON.stringify. Sorting is what makes the hash invariant under input key
 * order; the rest matches the JSON spec.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalJson cannot serialize ${typeof value}`);
}

/**
 * The 32-byte sha256 digest of an event's canonical JSON form, as a Buffer
 * suitable for direct insertion into the BLOB PRIMARY KEY of the events
 * table. Two events that are structurally equal hash to the same digest;
 * INSERT OR IGNORE then makes a re-ingest a no-op.
 */
export function eventHash(event: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(event)).digest();
}
