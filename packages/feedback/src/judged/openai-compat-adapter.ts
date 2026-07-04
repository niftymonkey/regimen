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

export interface OpenAiCompatJudgeModelOptions {
  /** The bearer key; omit for a keyless local endpoint (no Authorization header). */
  readonly apiKey?: string;
  /** The engineer-chosen model id, sent opaque. */
  readonly model: string;
  /** The chat-completions base URL, e.g. an OpenRouter or local endpoint. */
  readonly baseUrl: string;
  /** Injectable for tests; defaults to the global fetch in production. */
  readonly fetch?: typeof fetch;
}

/** A sane output cap for one whole-conversation verdict (one JSON object). */
const MAX_TOKENS = 4096;

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

      const response = await doFetch(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `chat-completions endpoint returned ${response.status} ${response.statusText}`,
        );
      }

      const json = (await response.json()) as ChatCompletionResponse;
      const text = json.choices[0]?.message?.content ?? "";
      return { text, model: json.model };
    },
  };
}
