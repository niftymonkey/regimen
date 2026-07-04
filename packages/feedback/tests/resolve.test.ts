/**
 * The judge backend resolver (resolveJudgeModel), moved out of the Anthropic
 * adapter into its own module and grown to compose three adapters behind one
 * precedence policy (judge-backends design decisions 1 and 2). Every test
 * injects env, fetch, the PATH check, and the CLI runner, so the suite makes
 * ZERO network calls and ZERO spawns. The resolver returns both the port and the
 * backend tag it built, so provenance can record which backend judged.
 */
import { expect, test } from "bun:test";
import { resolveJudgeModel } from "../src/judged/resolve.ts";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function mockFetch(captured: CapturedRequest[], body: unknown): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

const CHAT_RESPONSE = {
  model: "some-model",
  choices: [{ message: { content: "{}" } }],
};
const ANTHROPIC_RESPONSE = {
  model: "claude-opus-4-8",
  content: [{ type: "text", text: "{}" }],
};

function cliRunner() {
  return () =>
    Promise.resolve({
      stdout: JSON.stringify({
        subtype: "success",
        is_error: false,
        result: "{}",
        modelUsage: { "claude-haiku-4-5-20251001": {} },
      }),
      stderr: "",
      exitCode: 0,
    });
}

test("REGIMEN_JUDGE_API_KEY selects the openai-compat backend, tagged api, defaulting to OpenRouter", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: { REGIMEN_JUDGE_API_KEY: "sk-or", REGIMEN_JUDGE_MODEL: "free-model" },
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  expect(resolved.backend).toBe("api");

  await resolved.port.complete({ system: "s", user: "u" });
  const call = captured[0]!;
  expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  const headers = call.init.headers as Record<string, string>;
  expect(headers["authorization"]).toBe("Bearer sk-or");
  const sent = JSON.parse(call.init.body as string);
  expect(sent.model).toBe("free-model");
});

test("REGIMEN_JUDGE_API_KEY set with no model named throws an actionable model error", () => {
  expect(() =>
    resolveJudgeModel({ env: { REGIMEN_JUDGE_API_KEY: "sk-or" } }),
  ).toThrow(/REGIMEN_JUDGE_MODEL/);
});

test("REGIMEN_JUDGE_API_KEY outranks an ambient ANTHROPIC_API_KEY", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: {
      REGIMEN_JUDGE_API_KEY: "sk-or",
      REGIMEN_JUDGE_MODEL: "free-model",
      ANTHROPIC_API_KEY: "sk-ant",
    },
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  await resolved.port.complete({ system: "s", user: "u" });
  expect(captured[0]!.url).toContain("/chat/completions");
});

test("REGIMEN_JUDGE_BASE_URL overrides the default endpoint", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: {
      REGIMEN_JUDGE_API_KEY: "sk-or",
      REGIMEN_JUDGE_MODEL: "free-model",
      REGIMEN_JUDGE_BASE_URL: "http://localhost:11434/v1",
    },
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  await resolved.port.complete({ system: "s", user: "u" });
  expect(captured[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
});

test("the --judge-model flag wins over REGIMEN_JUDGE_MODEL", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: { REGIMEN_JUDGE_API_KEY: "sk-or", REGIMEN_JUDGE_MODEL: "env-model" },
    model: "flag-model",
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  await resolved.port.complete({ system: "s", user: "u" });
  const sent = JSON.parse(captured[0]!.init.body as string);
  expect(sent.model).toBe("flag-model");
});

test("REGIMEN_JUDGE_BASE_URL plus REGIMEN_JUDGE_MODEL with no key selects the keyless openai-compat backend", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: {
      REGIMEN_JUDGE_BASE_URL: "http://localhost:11434/v1",
      REGIMEN_JUDGE_MODEL: "llama3",
    },
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  expect(resolved.backend).toBe("api");

  await resolved.port.complete({ system: "s", user: "u" });
  const call = captured[0]!;
  expect(call.url).toBe("http://localhost:11434/v1/chat/completions");
  // Keyless: no Authorization header is sent to the local endpoint.
  const headers = call.init.headers as Record<string, string>;
  expect(headers["authorization"]).toBeUndefined();
  const sent = JSON.parse(call.init.body as string);
  expect(sent.model).toBe("llama3");
});

test("the keyless deliberate REGIMEN_JUDGE_* configuration outranks an ambient ANTHROPIC_API_KEY", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: {
      REGIMEN_JUDGE_BASE_URL: "http://localhost:11434/v1",
      REGIMEN_JUDGE_MODEL: "llama3",
      ANTHROPIC_API_KEY: "sk-ant",
    },
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  await resolved.port.complete({ system: "s", user: "u" });
  expect(captured[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
});

test("REGIMEN_JUDGE_BASE_URL set with no model named throws the actionable model error", () => {
  expect(() =>
    resolveJudgeModel({
      env: { REGIMEN_JUDGE_BASE_URL: "http://localhost:11434/v1" },
    }),
  ).toThrow(/REGIMEN_JUDGE_MODEL/);
});

test("the --judge-model flag satisfies the keyless base-url configuration", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: { REGIMEN_JUDGE_BASE_URL: "http://localhost:11434/v1" },
    model: "flag-model",
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  await resolved.port.complete({ system: "s", user: "u" });
  const sent = JSON.parse(captured[0]!.init.body as string);
  expect(sent.model).toBe("flag-model");
});

test("ANTHROPIC_API_KEY (no REGIMEN_JUDGE_API_KEY) selects the anthropic backend, tagged api", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: { ANTHROPIC_API_KEY: "sk-ant" },
    fetch: mockFetch(captured, ANTHROPIC_RESPONSE),
  });
  expect(resolved.backend).toBe("api");
  await resolved.port.complete({ system: "s", user: "u" });
  expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
});

test("no key but claude on PATH selects the cli backend, tagged cli", async () => {
  const resolved = resolveJudgeModel({
    env: {},
    claudeOnPath: () => true,
    run: cliRunner(),
  });
  expect(resolved.backend).toBe("cli");
  const response = await resolved.port.complete({ system: "s", user: "u" });
  expect(response.model).toBe("claude-haiku-4-5-20251001");
});

test("no key and no claude throws an error naming all three remedies and the agent path", () => {
  let message = "";
  try {
    resolveJudgeModel({ env: {}, claudeOnPath: () => false });
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("REGIMEN_JUDGE_API_KEY");
  expect(message).toContain("ANTHROPIC_API_KEY");
  expect(message).toContain("claude");
  expect(message).toContain("--emit-prompt");
});

test("--judge-via cli forces the cli backend even when a key is present", async () => {
  const resolved = resolveJudgeModel({
    env: { ANTHROPIC_API_KEY: "sk-ant" },
    judgeVia: "cli",
    run: cliRunner(),
  });
  expect(resolved.backend).toBe("cli");
  await resolved.port.complete({ system: "s", user: "u" });
});

test("--judge-via api with REGIMEN_JUDGE_API_KEY picks the generic HTTP backend", async () => {
  const captured: CapturedRequest[] = [];
  const resolved = resolveJudgeModel({
    env: { REGIMEN_JUDGE_API_KEY: "sk-or", REGIMEN_JUDGE_MODEL: "free-model" },
    judgeVia: "api",
    fetch: mockFetch(captured, CHAT_RESPONSE),
  });
  await resolved.port.complete({ system: "s", user: "u" });
  expect(captured[0]!.url).toContain("/chat/completions");
});

test("--judge-via api with no key throws even when claude is on PATH", () => {
  expect(() =>
    resolveJudgeModel({ env: {}, judgeVia: "api", claudeOnPath: () => true }),
  ).toThrow(/ANTHROPIC_API_KEY/);
});
