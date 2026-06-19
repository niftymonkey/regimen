/**
 * Content-projection tests for the Codex rollout reader (S2).
 *
 * The projection reads conversation text from the canonical `response_item`
 * stream and anchors each chunk back to a deterministic event, never storing
 * the text. These tests pin: the canonical-stream dedup, the include/exclude
 * policy, per-tool argument extraction, tool-output unwrap and truncation, the
 * vscode injection filter with its marked boundary, reasoning and guardian
 * text exclusion, and the eventHash/tool anchors. They build small inline
 * transcripts plus the captured real fixtures under samples/.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  rolloutContent,
  type AnchorRef,
} from "../src/loader/rollout/codex-reader.ts";
import {
  codexAgentMessage,
  codexToolPre,
  codexUserPrompt,
  type CodexEventBase,
} from "../src/loader/translators/codex-events.ts";
import { eventHash } from "../src/hash.ts";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const SESSION = "019e0000-1111-7000-8000-00000000aaaa";

/** A non-vscode session so user messages pass the injection filter as-is. */
const execMeta = line({
  timestamp: "2026-06-03T10:00:00.000Z",
  type: "session_meta",
  payload: {
    id: SESSION,
    cwd: "/work/p",
    originator: "codex_exec",
    source: "exec",
  },
});

/** A vscode session so the IDE-wrapper injection filter applies. */
const vscodeMeta = line({
  timestamp: "2026-06-03T10:00:00.000Z",
  type: "session_meta",
  payload: {
    id: SESSION,
    cwd: "/work/p",
    originator: "codex_vscode",
    source: "vscode",
  },
});

function userMsg(timestamp: string, text: string): string {
  return line({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

function hashHexOf(event: object): string {
  return eventHash(event).toString("hex");
}

function isEventHashAnchor(
  anchor: AnchorRef,
): anchor is { readonly eventHash: string } {
  return "eventHash" in anchor;
}

test("a genuine human prompt projects one human_prompt chunk anchored by its user_prompt event hash", () => {
  const userMsg = line({
    timestamp: "2026-06-03T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "add a test for the parser" }],
    },
  });
  const chunks = rolloutContent([execMeta, userMsg].join("\n"));
  const prompts = chunks.filter((c) => c.kind === "human_prompt");
  expect(prompts.length).toBe(1);
  expect(prompts[0]!.text).toBe("add a test for the parser");

  // The anchor reproduces the user_prompt structural event the projection
  // derives from this canonical response_item, carrying the rollout sequence
  // index so its hash is collision-proof. The first anchored event is seq 0.
  const base: CodexEventBase = {
    sessionId: SESSION,
    timestamp: "2026-06-03T10:00:01.000Z",
    cwd: "/work/p",
  };
  const anchor = prompts[0]!.anchor;
  expect(isEventHashAnchor(anchor)).toBe(true);
  if (isEventHashAnchor(anchor)) {
    expect(anchor.eventHash).toBe(hashHexOf(codexUserPrompt(base, 0)));
  }
});

test("an assistant message projects an assistant_answer chunk anchored by its agent.message event hash", () => {
  const assistantMsg = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done. The parser test passes." }],
      phase: "final_answer",
    },
  });
  const chunks = rolloutContent([execMeta, assistantMsg].join("\n"));
  const answers = chunks.filter((c) => c.kind === "assistant_answer");
  expect(answers.length).toBe(1);
  expect(answers[0]!.text).toBe("Done. The parser test passes.");

  const base: CodexEventBase = {
    sessionId: SESSION,
    timestamp: "2026-06-03T10:00:02.000Z",
    cwd: "/work/p",
  };
  const anchor = answers[0]!.anchor;
  expect(isEventHashAnchor(anchor)).toBe(true);
  if (isEventHashAnchor(anchor)) {
    expect(anchor.eventHash).toBe(hashHexOf(codexAgentMessage(base, 0)));
  }
});

test("developer-role messages and reasoning produce no content chunk (excluded by record type)", () => {
  const developerMsg = line({
    timestamp: "2026-06-03T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: "permissions text",
    },
  });
  const plaintextReasoning = line({
    timestamp: "2026-06-03T10:00:01.500Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "**Considering the approach**" }],
      encrypted_content: "gAAAA...",
    },
  });
  const agentReasoning = line({
    timestamp: "2026-06-03T10:00:01.600Z",
    type: "event_msg",
    payload: { type: "agent_reasoning", text: "**private chain of thought**" },
  });
  const chunks = rolloutContent(
    [execMeta, developerMsg, plaintextReasoning, agentReasoning].join("\n"),
  );
  expect(chunks.length).toBe(0);
});

const IDE_WRAPPER =
  "# Context from my IDE setup:\n\n## Active file: src/x.ts\n\n## My request for Codex:\nfix the failing test";

test("a vscode IDE-wrapper message passes whole, keeping the boilerplate, the marked boundary, and the engineer's ask", () => {
  const chunks = rolloutContent(
    [vscodeMeta, userMsg("2026-06-03T10:00:01.000Z", IDE_WRAPPER)].join("\n"),
  );
  const prompts = chunks.filter((c) => c.kind === "human_prompt");
  expect(prompts.length).toBe(1);
  // The boundary is preserved in-band, not silently stripped: the boilerplate,
  // the marker, and the ask all survive.
  expect(prompts[0]!.text).toContain("# Context from my IDE setup:");
  expect(prompts[0]!.text).toContain("## My request for Codex:");
  expect(prompts[0]!.text).toContain("fix the failing test");
});

test("vscode environment_context, AGENTS.md, and guardian-replay user messages are excluded as machine-injected", () => {
  const envContext = userMsg(
    "2026-06-03T10:00:01.000Z",
    "<environment_context>\n  <cwd>/work/p</cwd>\n</environment_context>",
  );
  const agentsMd = userMsg(
    "2026-06-03T10:00:02.000Z",
    "# AGENTS.md instructions for /work/p\n\nUse TDD.",
  );
  const guardianReplay = userMsg(
    "2026-06-03T10:00:03.000Z",
    "The following is the Codex agent history whose request you are assessing.",
  );
  const chunks = rolloutContent(
    [vscodeMeta, envContext, agentsMd, guardianReplay].join("\n"),
  );
  expect(chunks.filter((c) => c.kind === "human_prompt").length).toBe(0);
});

test("pure machine-injection markers are excluded even in a non-vscode CLI session", () => {
  // <environment_context>, AGENTS.md, and guardian-replay blocks are injected
  // by the harness regardless of originator, so they are never engineer prose.
  const envContext = userMsg(
    "2026-06-03T10:00:01.000Z",
    "<environment_context>\n  <cwd>/work/p</cwd>\n</environment_context>",
  );
  const genuine = userMsg("2026-06-03T10:00:02.000Z", "does this work?");
  const chunks = rolloutContent([execMeta, envContext, genuine].join("\n"));
  const prompts = chunks.filter((c) => c.kind === "human_prompt");
  // Only the genuine CLI prompt survives; the injected block is dropped.
  expect(prompts.length).toBe(1);
  expect(prompts[0]!.text).toBe("does this work?");
});

function isToolAnchor(
  anchor: AnchorRef,
): anchor is { readonly sessionId: string; readonly toolCallId: string } {
  return "toolCallId" in anchor;
}

test("exec_command tool args extract the cmd string, anchored by sessionId+toolCallId", () => {
  const call = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"bun test","workdir":"/work/p","yield_time_ms":1000}',
      call_id: "call_exec_1",
    },
  });
  const chunks = rolloutContent([execMeta, call].join("\n"));
  const args = chunks.filter((c) => c.kind === "tool_args");
  expect(args.length).toBe(1);
  expect(args[0]!.text).toBe("bun test");
  const anchor = args[0]!.anchor;
  expect(isToolAnchor(anchor)).toBe(true);
  if (isToolAnchor(anchor)) {
    expect(anchor.sessionId).toBe(SESSION);
    expect(anchor.toolCallId).toBe("call_exec_1");
  }
});

test("OLDEST shell tool args extract the command string array, joined", () => {
  const call = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      arguments: '{"command":["bash","-lc","ls"],"workdir":"."}',
      call_id: "call_shell_1",
    },
  });
  const chunks = rolloutContent([execMeta, call].join("\n"));
  const args = chunks.filter((c) => c.kind === "tool_args");
  expect(args.length).toBe(1);
  expect(args[0]!.text).toBe("bash -lc ls");
});

test("apply_patch tool args extract the raw patch text from input", () => {
  const call = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch",
      call_id: "call_patch_1",
    },
  });
  const chunks = rolloutContent([execMeta, call].join("\n"));
  const args = chunks.filter((c) => c.kind === "tool_args");
  expect(args.length).toBe(1);
  expect(args[0]!.text).toContain("*** Begin Patch");
});

test("write_stdin args use chars, and an empty-chars write_stdin produces no tool_args chunk", () => {
  const withChars = line({
    timestamp: "2026-06-03T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "write_stdin",
      arguments: '{"chars":"y\\n","session_id":"s","yield_time_ms":1000}',
      call_id: "call_ws_1",
    },
  });
  const empty = line({
    timestamp: "2026-06-03T10:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "write_stdin",
      arguments: '{"chars":"","session_id":"s","max_output_tokens":2000}',
      call_id: "call_ws_2",
    },
  });
  const chunks = rolloutContent([execMeta, withChars, empty].join("\n"));
  const args = chunks.filter((c) => c.kind === "tool_args");
  expect(args.length).toBe(1);
  expect(args[0]!.text).toBe("y\n");
});

test("a raw tool output is projected as-is, anchored by sessionId+toolCallId", () => {
  const out = line({
    timestamp: "2026-06-03T10:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_exec_1",
      output: "Chunk ID: abc\nOutput:\nLinux\n",
    },
  });
  const chunks = rolloutContent([execMeta, out].join("\n"));
  const outputs = chunks.filter((c) => c.kind === "tool_output");
  expect(outputs.length).toBe(1);
  expect(outputs[0]!.text).toBe("Chunk ID: abc\nOutput:\nLinux\n");
  const anchor = outputs[0]!.anchor;
  expect(isToolAnchor(anchor)).toBe(true);
  if (isToolAnchor(anchor)) {
    expect(anchor.toolCallId).toBe("call_exec_1");
  }
});

test("an OLDEST JSON-wrapped tool output is unwrapped to its inner output string", () => {
  const out = line({
    timestamp: "2026-06-03T10:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_shell_1",
      output:
        '{"output":"CLAUDE.md\\nREADME.md\\n","metadata":{"exit_code":0}}',
    },
  });
  const chunks = rolloutContent([execMeta, out].join("\n"));
  const outputs = chunks.filter((c) => c.kind === "tool_output");
  expect(outputs.length).toBe(1);
  expect(outputs[0]!.text).toBe("CLAUDE.md\nREADME.md\n");
});

test("a large tool output is head+tail truncated with an elision marker, never silently emptied", () => {
  const big = "A".repeat(5000) + "ZZZ" + "B".repeat(5000);
  const out = line({
    timestamp: "2026-06-03T10:00:03.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_big_1",
      output: big,
    },
  });
  const chunks = rolloutContent([execMeta, out].join("\n"));
  const outputs = chunks.filter((c) => c.kind === "tool_output");
  expect(outputs.length).toBe(1);
  const text = outputs[0]!.text;
  expect(text.length).toBeLessThan(big.length);
  expect(text).toContain("elided");
  // Head and tail survive; the middle is what is dropped.
  expect(text.startsWith("A")).toBe(true);
  expect(text.endsWith("B")).toBe(true);
});

test("a web_search query projects a web_search_query chunk anchored by the self-paired span's event hash", () => {
  const search = line({
    timestamp: "2026-06-03T10:00:04.000Z",
    type: "response_item",
    payload: {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "bun current version", queries: [] },
    },
  });
  const chunks = rolloutContent([execMeta, search].join("\n"));
  const searches = chunks.filter((c) => c.kind === "web_search_query");
  expect(searches.length).toBe(1);
  expect(searches[0]!.text).toBe("bun current version");

  const base: CodexEventBase = {
    sessionId: SESSION,
    timestamp: "2026-06-03T10:00:04.000Z",
    cwd: "/work/p",
  };
  // Mirrors rolloutEvents: the first web search self-pairs as web_search:0.
  const span = codexToolPre(base, {
    toolName: "web_search",
    toolCallId: "web_search:0",
    query: "bun current version",
  });
  const anchor = searches[0]!.anchor;
  expect(isEventHashAnchor(anchor)).toBe(true);
  if (isEventHashAnchor(anchor)) {
    expect(anchor.eventHash).toBe(hashHexOf(span));
  }
});

test("a web_search open_page action carries no query and produces no chunk", () => {
  const openPage = line({
    timestamp: "2026-06-03T10:00:04.000Z",
    type: "response_item",
    payload: {
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page" },
    },
  });
  const chunks = rolloutContent([execMeta, openPage].join("\n"));
  expect(chunks.filter((c) => c.kind === "web_search_query").length).toBe(0);
});

const SAMPLES = join(import.meta.dir, "..", "samples");
function fixture(name: string): string {
  return readFileSync(join(SAMPLES, name), "utf8");
}

test("two assistant messages sharing one timestamp get distinct anchors and ascending lineSeq", () => {
  const chunks = rolloutContent(
    fixture("rollout-codex-timestamp-collision.jsonl"),
  );
  const answers = chunks.filter((c) => c.kind === "assistant_answer");
  expect(answers.length).toBe(2);
  // The sequence index makes the same-timestamp anchors differ, so neither is
  // dropped by INSERT OR IGNORE downstream.
  const hashes = answers
    .map((c) => c.anchor)
    .filter(isEventHashAnchor)
    .map((a) => a.eventHash);
  expect(hashes.length).toBe(2);
  expect(hashes[0]).not.toBe(hashes[1]);
  // Order is file-line order, not timestamp.
  expect(answers[0]!.lineSeq).toBeLessThan(answers[1]!.lineSeq);
});

test("the OLDEST 0.35.0 transcript projects IDE-wrapper prompts and shell args while dropping plaintext reasoning", () => {
  const chunks = rolloutContent(fixture("rollout-codex-oldest-0.35.0.jsonl"));
  // No chunk carries plaintext chain-of-thought: reasoning is excluded by type.
  for (const c of chunks) {
    expect(c.text).not.toContain("Considering repo overview strategy");
  }
  // The vscode IDE wrapper passes the engineer's ask with its marked boundary.
  const prompts = chunks.filter((c) => c.kind === "human_prompt");
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.some((p) => p.text.includes("## My request for Codex:"))).toBe(
    true,
  );
  // The <environment_context> machine block is excluded.
  expect(prompts.some((p) => p.text.startsWith("<environment_context>"))).toBe(
    false,
  );
  // OLDEST shell calls extract the joined command array (bash -lc ...).
  const args = chunks.filter((c) => c.kind === "tool_args");
  expect(args.length).toBeGreaterThan(0);
  expect(args.some((a) => a.text.startsWith("bash -lc"))).toBe(true);
});

test("the RECENT clean baseline projects assistant answers once, never double-counting the event_msg twin", () => {
  const chunks = rolloutContent(fixture("rollout-codex-recent-clean.jsonl"));
  // 7 assistant response_item messages; the event_msg agent_message twins are
  // never read, so the count is exactly the response_item count.
  const answers = chunks.filter((c) => c.kind === "assistant_answer");
  expect(answers.length).toBe(7);
  // Every assistant-answer anchor is unique (the seq makes same-ms ones differ).
  const hashes = new Set(
    answers
      .map((c) => c.anchor)
      .filter(isEventHashAnchor)
      .map((a) => a.eventHash),
  );
  expect(hashes.size).toBe(7);
});

test("the guardian subagent transcript projects no human prompts (whole session flagged non-human)", () => {
  const chunks = rolloutContent(
    fixture("rollout-codex-mid-guardian-subagent.jsonl"),
  );
  expect(chunks.filter((c) => c.kind === "human_prompt").length).toBe(0);
});

test("the rich-tools transcript projects apply_patch and exec args, tool output, web search, and the genuine IDE-wrapped ask", () => {
  const chunks = rolloutContent(fixture("rollout-codex-mid-rich-tools.jsonl"));
  const args = chunks.filter((c) => c.kind === "tool_args");
  expect(args.some((a) => a.text.includes("*** Begin Patch"))).toBe(true);
  expect(chunks.some((c) => c.kind === "tool_output")).toBe(true);
  expect(chunks.some((c) => c.kind === "web_search_query")).toBe(true);
  // The genuine engineer ask rides an IDE wrapper and passes with its boundary.
  const prompts = chunks.filter((c) => c.kind === "human_prompt");
  expect(prompts.some((p) => p.text.includes("## My request for Codex:"))).toBe(
    true,
  );
  // guardian_assessment is never projected as text.
  for (const c of chunks) {
    expect(c.text).not.toContain("guardian_assessment");
    expect(c.text).not.toContain("risk_level");
  }
});
