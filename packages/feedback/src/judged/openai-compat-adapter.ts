/**
 * A third production JudgeModelPort speaking the OpenAI-compatible
 * chat-completions wire format (judge-backends design decision 1).
 *
 * This is the tier A generic backend: one adapter serves every provider that
 * speaks chat-completions (OpenRouter, OpenAI, Groq, a local Ollama or LM
 * Studio), purely by configuration. It names no vendor; `baseUrl` and `model`
 * are opaque config the resolver supplies (OpenRouter is only the resolver's
 * default base URL). It maps the port's one `complete()` call to a single
 * `POST {baseUrl}/chat/completions` with the system and user as the two messages
 * and returns `choices[0].message.content` as the text and the response `model`
 * as provenance. The `apiKey` is optional so a keyless local endpoint works with
 * no Authorization header. `fetch` is injected so the adapter is unit-testable
 * with zero network.
 *
 * `request.responseSchema` is IGNORED: chat-completions structured-output
 * support varies across providers, and the Judge validates the verdict out of
 * `text` and retries on a parse error regardless, so an unsupporting backend
 * still works, exactly as the claude CLI adapter does.
 */
import type {
  JudgeModelPort,
  JudgeModelRequest,
  JudgeModelResponse,
} from "./port.ts";
import { errorBodySuffix } from "./error-body.ts";

export interface OpenAiCompatJudgeModelOptions {
  /** The bearer key; omit for a keyless local endpoint (no Authorization header). */
  readonly apiKey?: string;
  /** The engineer-chosen model id, sent opaque. */
  readonly model: string;
  /** The chat-completions base URL, e.g. an OpenRouter or local endpoint. */
  readonly baseUrl: string;
  /** The request deadline in milliseconds; injectable for tests. */
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch in production. */
  readonly fetch?: typeof fetch;
}

/**
 * The output cap for one whole-conversation verdict. Sized for a reasoning
 * backend: a thinking model (via OpenRouter, or Anthropic's own OpenAI-compat
 * endpoint) spends completion tokens on internal reasoning that never reaches
 * message.content before emitting the verdict JSON, and that reasoning grows
 * with transcript length. A cap sized for the JSON alone (the ~4k the
 * Anthropic-native adapter uses, where thinking is off) truncated the verdict
 * mid-object on the longest sessions (finish_reason=length), failing the parse;
 * this leaves headroom for reasoning plus the JSON. Only tokens actually
 * generated are billed, so the higher ceiling costs nothing on a session that
 * finishes early.
 */
const MAX_TOKENS = 16384;

/**
 * The default request deadline. A stalled endpoint (a real failure mode for the
 * local keyless backends this adapter targets) must fail the port call, which
 * the Judge maps to an honest llm-unavailable run, rather than wedge the process
 * indefinitely. A reasoning backend (a thinking model, or Anthropic's own
 * OpenAI-compat endpoint) legitimately runs past a minute on a long
 * conversation: it spends the raised completion budget on internal reasoning
 * before emitting the verdict (measured ~70s for one whole-conversation verdict,
 * and longer on the longest transcripts), so the bound is minutes, not seconds,
 * while still failing a genuinely dead endpoint.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/** One choice of a chat-completions response. */
interface ChatCompletionChoice {
  readonly message?: { readonly content?: string };
}

/** The subset of the chat-completions response this adapter reads. */
interface ChatCompletionResponse {
  readonly model: string;
  readonly choices: ReadonlyArray<ChatCompletionChoice>;
}

export function openAiCompatJudgeModel(
  options: OpenAiCompatJudgeModelOptions,
): JudgeModelPort {
  const doFetch = options.fetch ?? fetch;
  return {
    async complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.apiKey !== undefined && options.apiKey.length > 0) {
        headers["authorization"] = `Bearer ${options.apiKey}`;
      }

      // Bound the request so a stalled endpoint fails the port call instead of
      // hanging complete() (and with it the whole assess) forever.
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
            max_tokens: MAX_TOKENS,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          }),
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(
            `chat-completions request timed out after ${timeoutMs}ms; the endpoint at ${options.baseUrl} did not respond`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The body carries the only diagnosis there is: a low balance, a bad
        // key and a rate limit are indistinguishable from the status alone.
        const said = await errorBodySuffix(response);
        throw new Error(
          `chat-completions endpoint returned ${response.status} ${response.statusText}${said}`,
        );
      }

      const json = (await response.json()) as ChatCompletionResponse;
      const text = json.choices[0]?.message?.content ?? "";
      return { text, model: json.model };
    },
  };
}
