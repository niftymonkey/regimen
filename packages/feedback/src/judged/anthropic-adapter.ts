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
import {
  claudeCliJudgeModel,
  type RunClaudeCli,
} from "./claude-cli-adapter.ts";

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

export interface ResolveDefaultJudgeModelOptions {
  /** The `--judge-model` override; omit for the env/default model. */
  readonly model?: string;
  /**
   * The `--judge-via` override forcing one backend: `"api"` requires
   * ANTHROPIC_API_KEY and POSTs the Anthropic HTTP API; `"cli"` shells out to
   * the local `claude` CLI. Omit to auto-select (key present -> API, else CLI).
   */
  readonly judgeVia?: "cli" | "api";
  /** Injectable for tests; defaults to process.env in production. */
  readonly env?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to the global fetch in production. */
  readonly fetch?: typeof fetch;
  /**
   * Whether the `claude` CLI is on PATH. Injectable for tests because
   * `Bun.which` ignores in-process PATH mutation; defaults to a real
   * `Bun.which("claude")` check.
   */
  readonly claudeOnPath?: () => boolean;
  /** Injectable for tests so the CLI adapter needs no real spawn. */
  readonly run?: RunClaudeCli;
}

/** The default judge model and base URL when env does not override them. */
const DEFAULT_JUDGE_MODEL = "claude-opus-4-8";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Construct the production judge adapter over the engineer's already-configured
 * Claude (spec section 3), auto-selecting between the two backends.
 *
 * When ANTHROPIC_API_KEY is present the HTTP adapter is used (reading the model
 * from ANTHROPIC_MODEL or the date-stamped default, overridden by
 * `options.model` i.e. the --judge-model flag, and the base URL from
 * ANTHROPIC_BASE_URL or the default; never a hardcoded key). When the key is
 * absent but the `claude` CLI is on PATH the CLI adapter is used, reusing
 * whatever auth Claude Code already has (Bedrock, OAuth, Vertex, or a direct
 * key) with no separate key. `--judge-via` forces one backend. With neither a
 * key nor the CLI available it throws an actionable error naming both.
 * `judgeConversation` uses this when `config.llm` is omitted.
 */
export function resolveDefaultJudgeModel(
  options: ResolveDefaultJudgeModelOptions = {},
): JudgeModelPort {
  const env = options.env ?? process.env;
  const apiKey = env.ANTHROPIC_API_KEY;
  const hasKey = apiKey !== undefined && apiKey.length > 0;
  const claudeOnPath =
    options.claudeOnPath ??
    (() => Bun.which("claude", { PATH: env.PATH ?? "" }) !== null);

  // The CLI adapter passes the model only when --judge-model was set, letting
  // Claude Code choose its own default otherwise.
  const cliAdapter = (): JudgeModelPort =>
    claudeCliJudgeModel({
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });

  const httpAdapter = (): JudgeModelPort => {
    if (!hasKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set; the judge LLM is the engineer's configured Claude and reads its key from the environment",
      );
    }
    const model = options.model ?? env.ANTHROPIC_MODEL ?? DEFAULT_JUDGE_MODEL;
    const baseUrl = env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;
    return anthropicJudgeModel({
      apiKey,
      model,
      baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  };

  if (options.judgeVia === "api") return httpAdapter();
  if (options.judgeVia === "cli") return cliAdapter();

  if (hasKey) return httpAdapter();
  if (claudeOnPath()) return cliAdapter();
  throw new Error(
    "ANTHROPIC_API_KEY is not set and the claude CLI is not on PATH; set ANTHROPIC_API_KEY for the HTTP judge, or install/authenticate the claude CLI for the local judge",
  );
}
