import { expect, test } from "bun:test";
import { harnessSupport } from "../src/harness/support.ts";

const SESSION = "019e0000-1111-7000-8000-000000000abc";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** A minimal Codex rollout: a session_meta plus one user-prompt response item. */
const fixture = [
  line({
    timestamp: "2026-06-02T10:00:00.100Z",
    type: "session_meta",
    payload: { id: SESSION, cwd: "/work/sample", source: "cli" },
  }),
  line({
    timestamp: "2026-06-02T10:00:00.400Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "run the tests" }],
    },
  }),
].join("\n");

test("harnessSupport(codex).reader.read parses a transcript via rolloutRead", () => {
  const support = harnessSupport("codex");
  expect(support).toBeDefined();
  const read = support!.reader.read(fixture, { complete: true });

  const starts = read.events.filter((e) => e.event_type === "session.start");
  expect(starts.length).toBe(1);
  expect(starts[0]?.session_id).toBe(SESSION);

  const prompts = read.content.filter((c) => c.kind === "human_prompt");
  expect(prompts.length).toBe(1);
  expect(prompts[0]?.text).toBe("run the tests");
});
