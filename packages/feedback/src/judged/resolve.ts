/**
 * The judge backend resolver (judge-backends design decisions 1 and 2). It
 * composes the three JudgeModelPort adapters (the generic OpenAI-compatible
 * backend, the Anthropic-native backend, the Claude CLI backend) behind one
 * precedence policy and the vendor-neutral REGIMEN_JUDGE_* env family layered
 * over the existing ambient ANTHROPIC_* vars. It returns both the port and the
 * backend tag it built, so provenance can record which backend judged (never
 * self-reported). Lifted out of anthropic-adapter.ts, where it was a locality
 * lie: it names three adapters, not one.
 *
 * Precedence for auto-selection (no --judge-via): a deliberate
 * REGIMEN_JUDGE_API_KEY (the generic backend) outranks an ambient
 * ANTHROPIC_API_KEY (often set for other tooling), which outranks the local
 * `claude` CLI. With none available it throws an actionable error naming all
 * three remedies plus the zero-key agent path. `--judge-via` forces a backend;
 * the `--judge-model` flag wins over env on the model.
 */
import type { JudgeModelPort } from "./port.ts";
import type { JudgeBackend } from "./types.ts";
import { anthropicJudgeModel } from "./anthropic-adapter.ts";
import { openAiCompatJudgeModel } from "./openai-compat-adapter.ts";
import {
  claudeCliJudgeModel,
  type RunClaudeCli,
} from "./claude-cli-adapter.ts";

export interface ResolveJudgeModelOptions {
  /** The `--judge-model` override; wins over the env model when both are set. */
  readonly model?: string;
  /**
   * The `--judge-via` override forcing one in-process backend. `"api"` picks the
   * HTTP backend the env selects (generic when REGIMEN_JUDGE_API_KEY is set, else
   * Anthropic; error when neither key exists); `"cli"` shells out to the local
   * `claude` CLI. Omit to auto-select by precedence. `agent` is not a resolver
   * input: the process cannot await its own calling agent, so the CLI handles it.
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

/** A resolved judge: the port that judges, and the backend tag it runs. */
export interface ResolvedJudge {
  readonly port: JudgeModelPort;
  readonly backend: JudgeBackend;
}

/** The Anthropic-native defaults when env does not override them. */
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** The generic backend default endpoint (OpenRouter); any compatible URL works. */
const DEFAULT_GENERIC_BASE_URL = "https://openrouter.ai/api/v1";

/** A free example model to make the missing-model error actionable. */
const FREE_MODEL_EXAMPLE = "meta-llama/llama-3.3-70b-instruct:free";

const NO_BACKEND_ERROR =
  "no judge backend is configured: set REGIMEN_JUDGE_API_KEY (+ REGIMEN_JUDGE_MODEL) for any OpenAI-compatible provider, set ANTHROPIC_API_KEY, install the claude CLI, or judge with the current agent via `regimen assess --emit-prompt` / `--record-verdict` (the regimen-judgment skill drives this)";

/**
 * Resolve the judge backend from the flag overrides and the environment,
 * returning the port and the backend tag. `judgeConversation` uses this when
 * `config.llm` is omitted; the CLI facades use it to record the backend on
 * provenance. Throws an actionable error when no backend is available.
 */
export function resolveJudgeModel(
  options: ResolveJudgeModelOptions = {},
): ResolvedJudge {
  const env = options.env ?? process.env;
  const regimenKey = nonEmpty(env.REGIMEN_JUDGE_API_KEY);
  const anthropicKey = nonEmpty(env.ANTHROPIC_API_KEY);
  const claudeOnPath =
    options.claudeOnPath ??
    (() => Bun.which("claude", { PATH: env.PATH ?? "" }) !== null);

  if (options.judgeVia === "cli") return cliBackend(options, env);
  if (options.judgeVia === "api") {
    return regimenKey !== undefined
      ? genericBackend(options, env, regimenKey)
      : anthropicBackend(options, env, anthropicKey);
  }

  if (regimenKey !== undefined) return genericBackend(options, env, regimenKey);
  if (anthropicKey !== undefined) {
    return anthropicBackend(options, env, anthropicKey);
  }
  if (claudeOnPath()) return cliBackend(options, env);
  throw new Error(NO_BACKEND_ERROR);
}

/** The generic OpenAI-compatible backend; the model is required (no universal default). */
function genericBackend(
  options: ResolveJudgeModelOptions,
  env: Record<string, string | undefined>,
  apiKey: string,
): ResolvedJudge {
  const model = options.model ?? nonEmpty(env.REGIMEN_JUDGE_MODEL);
  if (model === undefined) {
    throw new Error(
      `REGIMEN_JUDGE_API_KEY is set but no judge model is named; set REGIMEN_JUDGE_MODEL (e.g. a free OpenRouter model like "${FREE_MODEL_EXAMPLE}") or pass --judge-model`,
    );
  }
  const baseUrl =
    nonEmpty(env.REGIMEN_JUDGE_BASE_URL) ?? DEFAULT_GENERIC_BASE_URL;
  return {
    backend: "api",
    port: openAiCompatJudgeModel({
      apiKey,
      model,
      baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  };
}

/** The Anthropic-native backend (today's behavior); REGIMEN_JUDGE_MODEL is honored below the flag. */
function anthropicBackend(
  options: ResolveJudgeModelOptions,
  env: Record<string, string | undefined>,
  apiKey: string | undefined,
): ResolvedJudge {
  if (apiKey === undefined) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set; the judge LLM is the engineer's configured Claude and reads its key from the environment",
    );
  }
  const model =
    options.model ??
    nonEmpty(env.REGIMEN_JUDGE_MODEL) ??
    nonEmpty(env.ANTHROPIC_MODEL) ??
    DEFAULT_ANTHROPIC_MODEL;
  const baseUrl =
    nonEmpty(env.ANTHROPIC_BASE_URL) ?? DEFAULT_ANTHROPIC_BASE_URL;
  return {
    backend: "api",
    port: anthropicJudgeModel({
      apiKey,
      model,
      baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
  };
}

/** The Claude CLI backend; the model is passed only when named (flag or REGIMEN_JUDGE_MODEL). */
function cliBackend(
  options: ResolveJudgeModelOptions,
  env: Record<string, string | undefined>,
): ResolvedJudge {
  const model = options.model ?? nonEmpty(env.REGIMEN_JUDGE_MODEL);
  return {
    backend: "cli",
    port: claudeCliJudgeModel({
      ...(model === undefined ? {} : { model }),
      ...(options.run === undefined ? {} : { run: options.run }),
    }),
  };
}

/** A trimmed non-empty string, or undefined for an unset or empty env var. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
