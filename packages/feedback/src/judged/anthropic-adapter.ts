/**
 * The production JudgeModelPort: a thin raw-fetch POST to the Anthropic
 * Messages API (S3, spec section 3).
 *
 * The judge is the engineer's already-configured Claude (resolved 9.2): the
 * adapter reads ANTHROPIC_API_KEY, the model, and the base URL from the
 * environment at runtime, never a hardcoded key. It maps the port's one
 * `complete()` call to one `/v1/messages` request (system + user, an optional
 * JSON-schema structured-output hint, a sane max_tokens) and returns the
 * answering model id as `response.model` so provenance is self-describing. The
 * `fetch` is injected so the adapter is unit-testable with zero network.
 */
import type {
  JudgeModelPort,
  JudgeModelRequest,
  JudgeModelResponse,
} from "./port.ts";

export interface AnthropicJudgeModelOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  /** Injectable for tests; defaults to the global fetch in production. */
  readonly fetch?: typeof fetch;
}

/** The pinned Anthropic Messages API version this adapter speaks. */
const ANTHROPIC_VERSION = "2023-06-01";

/** A sane output cap for one whole-conversation verdict (one JSON object). */
const MAX_TOKENS = 4096;

/** One text block of an Anthropic Messages response. */
interface AnthropicTextBlock {
  readonly type: string;
  readonly text?: string;
}

/** The subset of the Anthropic Messages response this adapter reads. */
interface AnthropicMessagesResponse {
  readonly model: string;
  readonly content: ReadonlyArray<AnthropicTextBlock>;
}

export function anthropicJudgeModel(
  options: AnthropicJudgeModelOptions,
): JudgeModelPort {
  const doFetch = options.fetch ?? fetch;
  return {
    async complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
      const body: Record<string, unknown> = {
        model: options.model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      };
      // Pass the structured-output hint on when the Judge supplied one
      // (spec 2e): the model is asked to emit the verdict JSON shape, but the
      // Judge validates regardless, so an unsupporting model still works.
      if (request.responseSchema !== undefined) {
        body.output_config = {
          format: { type: "json_schema", schema: request.responseSchema },
        };
      }

      const response = await doFetch(`${options.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `Anthropic Messages API returned ${response.status} ${response.statusText}`,
        );
      }

      const json = (await response.json()) as AnthropicMessagesResponse;
      const text = json.content
        .flatMap((block) =>
          block.type === "text" && block.text !== undefined ? [block.text] : [],
        )
        .join("");
      return { text, model: json.model };
    },
  };
}
