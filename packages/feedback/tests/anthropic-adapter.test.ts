/**
 * The production Anthropic adapter (anthropicJudgeModel) (S3, spec section 3).
 * Tested thinnest: the adapter maps one JudgeModelRequest to one /v1/messages
 * POST and reads response.model back, with `fetch` mocked at the boundary so the
 * suite makes ZERO network calls. Backend selection now lives in resolve.ts
 * (resolve.test.ts); the real Anthropic round-trip is a separate manual
 * validation, never part of the build.
 */
import { expect, test } from "bun:test";
import { anthropicJudgeModel } from "../src/judged/anthropic-adapter.ts";

/** A captured request the mock fetch recorded. */
interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/**
 * A mock fetch that records the one call and returns a canned Anthropic
 * Messages response. No network: it resolves synchronously to a Response shape.
 */
function mockFetch(
  captured: CapturedRequest[],
  body: unknown,
  status = 200,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

const ANTHROPIC_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [{ type: "text", text: '{"intent":{"value":"feature"}}' }],
  stop_reason: "end_turn",
};

test("the adapter POSTs one /v1/messages request and returns text plus the answering model", async () => {
  const captured: CapturedRequest[] = [];
  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    fetch: mockFetch(captured, ANTHROPIC_RESPONSE),
  });

  const response = await llm.complete({
    system: "you are the judge",
    user: "the conversation chunks",
  });

  expect(response.text).toBe('{"intent":{"value":"feature"}}');
  expect(response.model).toBe("claude-opus-4-8");

  expect(captured).toHaveLength(1);
  const call = captured[0]!;
  expect(call.url).toBe("https://api.anthropic.com/v1/messages");
  expect(call.init.method).toBe("POST");

  const headers = call.init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-ant-test");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  expect(headers["content-type"]).toBe("application/json");

  const sent = JSON.parse(call.init.body as string);
  expect(sent.model).toBe("claude-opus-4-8");
  expect(sent.system).toBe("you are the judge");
  expect(sent.messages).toEqual([
    { role: "user", content: "the conversation chunks" },
  ]);
  expect(typeof sent.max_tokens).toBe("number");
  expect(sent.max_tokens).toBeGreaterThan(0);
  // No structured-output hint passed: the body omits output_config entirely.
  expect(sent.output_config).toBeUndefined();
});

test("the adapter passes a responseSchema on as output_config.format", async () => {
  const captured: CapturedRequest[] = [];
  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    fetch: mockFetch(captured, ANTHROPIC_RESPONSE),
  });

  const schema = {
    type: "object",
    properties: { intent: { type: "object" } },
  };
  await llm.complete({
    system: "you are the judge",
    user: "the conversation chunks",
    responseSchema: schema,
  });

  const sent = JSON.parse(captured[0]!.init.body as string);
  expect(sent.output_config).toEqual({
    format: { type: "json_schema", schema },
  });
});

test("the adapter joins only defined text blocks, skipping non-text and text-less blocks", async () => {
  const captured: CapturedRequest[] = [];
  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    fetch: mockFetch(captured, {
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "left " },
        // A tool_use-shaped block with no text, and a text block whose text is
        // absent: neither may contribute the string "undefined" to the join.
        { type: "tool_use", id: "t1" },
        { type: "text" },
        { type: "text", text: "right" },
      ],
    }),
  });

  const response = await llm.complete({ system: "s", user: "u" });
  expect(response.text).toBe("left right");
});

test("the adapter passes an abort signal to fetch so a stalled endpoint is bounded", async () => {
  const captured: CapturedRequest[] = [];
  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    fetch: mockFetch(captured, ANTHROPIC_RESPONSE),
  });

  await llm.complete({ system: "s", user: "u" });
  expect(captured[0]!.init.signal).toBeInstanceOf(AbortSignal);
});

test("the adapter surfaces a clean timeout error when the endpoint stalls past the deadline", async () => {
  // A fetch that honors its abort signal but otherwise never resolves, the
  // wedged-endpoint failure mode; a tiny injected timeout keeps the test
  // instant.
  const stalledFetch = ((
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    })) as typeof fetch;

  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    timeoutMs: 10,
    fetch: stalledFetch,
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(
    /timed out/,
  );
});

test("the adapter throws on a non-2xx response so the Judge sees a transport failure", async () => {
  const captured: CapturedRequest[] = [];
  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    // A well-formed body on a 401: the throw must come from the status check,
    // not from a crash on missing fields.
    fetch: mockFetch(
      captured,
      { model: "claude-opus-4-8", content: [{ type: "text", text: "{}" }] },
      401,
    ),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow();
});

test("a non-2xx error carries the provider's own words, not just the status", async () => {
  const captured: CapturedRequest[] = [];
  const llm = anthropicJudgeModel({
    apiKey: "sk-ant-test",
    model: "claude-opus-4-8",
    baseUrl: "https://api.anthropic.com",
    fetch: mockFetch(
      captured,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Your credit balance is too low to access the Anthropic API.",
        },
      },
      400,
    ),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(
    /credit balance is too low/,
  );
});
