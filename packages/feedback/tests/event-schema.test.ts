import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SCHEMA: object = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "schemas", "event.schema.json"),
    "utf8",
  ),
);
const SAMPLE = join(import.meta.dir, "..", "samples", "event.jsonl");

/** The event shape, as the sample fixture is read back for assertions. */
interface SampleEvent {
  schema_version: string;
  timestamp: string;
  session_id: string;
  harness: string;
  model?: string;
  event_type: string;
  trace_id: string;
  span_phase: string;
  span_name: string;
  attributes: Record<string, unknown>;
}

function readSample(): SampleEvent[] {
  return readFileSync(SAMPLE, "utf8")
    .trim()
    .split("\n")
    .map((line): SampleEvent => JSON.parse(line));
}

/** The first sample event matching predicate, asserting one exists. */
function sampleEvent(predicate: (event: SampleEvent) => boolean): SampleEvent {
  const found = readSample().find(predicate);
  if (found === undefined)
    throw new Error("expected a matching event in the sample");
  return found;
}

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

test("every event in the sample validates against the schema", () => {
  for (const event of readSample()) {
    validate(event);
    expect(
      validate.errors ?? [],
      `${event.event_type} should satisfy the schema`,
    ).toEqual([]);
  }
});

test("compaction is one normalized point marker", () => {
  const compactions = readSample().filter(
    (event) => event.event_type === "compaction",
  );
  expect(compactions.length).toBe(1);
  for (const compaction of compactions) {
    expect(compaction.span_phase).toBe("point");
    expect(compaction.span_name).toBe("compaction");
  }
});

test("model is recorded per event, so a mid-session change is representable", () => {
  const events = readSample();
  const models = new Set(
    events.flatMap((event) => (event.model === undefined ? [] : [event.model])),
  );
  expect(models.size).toBeGreaterThan(1);
});

test("model is optional: no model is resolved before the first turn", () => {
  for (const start of readSample().filter(
    (event) => event.event_type === "session.start",
  )) {
    expect(start.model).toBeUndefined();
  }
});

test("the harness enum admits a non-Claude harness", () => {
  expect(new Set(readSample().map((event) => event.harness))).toEqual(
    new Set(["cursor"]),
  );
});

test("a compaction event with a non-point span_phase is rejected", () => {
  const broken = {
    ...sampleEvent((event) => event.event_type === "compaction"),
    span_phase: "start",
  };
  validate(broken);
  expect(validate.errors ?? []).not.toEqual([]);
});

test("an unknown top-level field is rejected", () => {
  const broken = { ...sampleEvent(() => true), unexpected_field: true };
  validate(broken);
  expect(validate.errors ?? []).not.toEqual([]);
});

function sessionEnd(attributes: Record<string, unknown>): object {
  return {
    schema_version: 1,
    timestamp: "2026-06-12T12:00:00.000Z",
    session_id: "schema-end-session",
    harness: "claude",
    event_type: "session.end",
    trace_id: "0123456789abcdef0123456789abcdef",
    span_phase: "end",
    span_name: "session",
    attributes,
  };
}

test("a session.end carrying the native and normalized end reason validates", () => {
  validate(
    sessionEnd({
      end_reason_native: "prompt_input_exit",
      end_reason_normalized: "user_exit",
    }),
  );
  expect(validate.errors ?? []).toEqual([]);
});

test("a session.end with no end-reason attributes still validates (additive, pre-change events load)", () => {
  validate(sessionEnd({}));
  expect(validate.errors ?? []).toEqual([]);
});

test("a normalized end reason outside the vocabulary is rejected", () => {
  validate(sessionEnd({ end_reason_normalized: "made_up_reason" }));
  expect(validate.errors ?? []).not.toEqual([]);
});

test("a forward-looking reason like completed is deliberately excluded from the minimal vocabulary", () => {
  validate(sessionEnd({ end_reason_normalized: "completed" }));
  expect(validate.errors ?? []).not.toEqual([]);
});
