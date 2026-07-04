/**
 * The OpenAI-compatible adapter (openAiCompatJudgeModel), the tier A generic
 * JudgeModelPort that speaks the chat-completions wire format (OpenRouter,
 * OpenAI, Groq, a local Ollama, all compatible). Built and tested thinnest,
 * mirroring the Anthropic adapter: `fetch` is mocked at the boundary so the
 * suite makes ZERO network calls. It names no vendor; the base URL and model are
 * pure configuration.
 */
import { expect, test } from "bun:test";
import { openAiCompatJudgeModel } from "../src/judged/openai-compat-adapter.ts";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

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

const CHAT_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "meta-llama/llama-3.3-70b-instruct:free",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: '{"intent":{"value":"feature"}}' },
      finish_reason: "stop",
    },
  ],
};

test("the adapter POSTs one /chat/completions request and returns content plus the answering model", async () => {
  const captured: CapturedRequest[] = [];
  const llm = openAiCompatJudgeModel({
    apiKey: "sk-or-test",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    baseUrl: "https://openrouter.ai/api/v1",
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });

  const response = await llm.complete({
    system: "you are the judge",
    user: "the conversation chunks",
  });

  expect(response.text).toBe('{"intent":{"value":"feature"}}');
  expect(response.model).toBe("meta-llama/llama-3.3-70b-instruct:free");

  expect(captured).toHaveLength(1);
  const call = captured[0]!;
  expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(call.init.method).toBe("POST");

  const headers = call.init.headers as Record<string, string>;
  expect(headers["authorization"]).toBe("Bearer sk-or-test");
  expect(headers["content-type"]).toBe("application/json");

  const sent = JSON.parse(call.init.body as string);
  expect(sent.model).toBe("meta-llama/llama-3.3-70b-instruct:free");
  expect(sent.messages).toEqual([
    { role: "system", content: "you are the judge" },
    { role: "user", content: "the conversation chunks" },
  ]);
});

test("the adapter omits the Authorization header when no apiKey is configured (keyless local endpoint)", async () => {
  const captured: CapturedRequest[] = [];
  const llm = openAiCompatJudgeModel({
    model: "llama3",
    baseUrl: "http://localhost:11434/v1",
    fetch: mockFetch(captured, {
      model: "llama3",
      choices: [{ message: { content: "{}" } }],
    }),
  });

  await llm.complete({ system: "s", user: "u" });

  const headers = captured[0]!.init.headers as Record<string, string>;
  expect(headers["authorization"]).toBeUndefined();
  expect(captured[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
});

test("the adapter throws on a non-2xx response so the Judge sees a transport failure", async () => {
  const captured: CapturedRequest[] = [];
  const llm = openAiCompatJudgeModel({
    apiKey: "sk-or-test",
    model: "some-model",
    baseUrl: "https://openrouter.ai/api/v1",
    fetch: mockFetch(
      captured,
      { model: "some-model", choices: [{ message: { content: "{}" } }] },
      429,
    ),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow();
});

test("the adapter returns an empty string when the response carries no choice content", async () => {
  const captured: CapturedRequest[] = [];
  const llm = openAiCompatJudgeModel({
    apiKey: "sk-or-test",
    model: "some-model",
    baseUrl: "https://openrouter.ai/api/v1",
    fetch: mockFetch(captured, { model: "some-model", choices: [] }),
  });

  const response = await llm.complete({ system: "s", user: "u" });
  expect(response.text).toBe("");
  expect(response.model).toBe("some-model");
});
