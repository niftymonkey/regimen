/**
 * A second production JudgeModelPort that shells out to the engineer's
 * already-authenticated Claude Code CLI (`claude --print`) instead of POSTing to
 * the Anthropic HTTP API.
 *
 * The judge is the engineer's already-configured Claude (resolved 9.2). This
 * adapter exists for environments where there is no direct ANTHROPIC_API_KEY and
 * the public API is blocked (e.g. Claude Code on AWS Bedrock GovCloud): it reuses
 * whatever auth Claude Code already has (Bedrock, OAuth, Vertex, or a direct key)
 * with NO separate key. It maps the port's one `complete()` call to a single
 * `claude --print --output-format json --max-turns 1 --system-prompt <SYSTEM>`
 * invocation with the user prompt PIPED TO STDIN (the prompt is a whole-
 * conversation projection that can be large and would blow past ARG_MAX / the
 * Windows command-length limit as an argv string). The runner is injected so the
 * adapter is unit-testable with zero real spawn; the production runner uses
 * `Bun.spawn`.
 *
 * The answering model id comes from the first key of the CLI's `modelUsage`
 * object (on Bedrock this is the real Bedrock model id); there is no top-level
 * `model` field. `request.responseSchema` is IGNORED: the claude CLI has no
 * structured-output flag, and the Judge validates the verdict out of `text`
 * regardless and retries on a parse error, so an unsupporting backend still
 * works.
 */
import type {
  JudgeModelPort,
  JudgeModelRequest,
  JudgeModelResponse,
} from "./port.ts";

/** The captured result of one `claude` CLI invocation. */
export interface ClaudeCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run the `claude` CLI with the given args and stdin input, resolving to its
 * captured stdout/stderr/exitCode. Injected so tests need no real spawn.
 */
export type RunClaudeCli = (
  args: ReadonlyArray<string>,
  input: string,
) => Promise<ClaudeCliResult>;

export interface ClaudeCliJudgeModelOptions {
  /** The `--judge-model` override; omit to let Claude Code use its default. */
  readonly model?: string;
  /** Injectable for tests; defaults to a real `Bun.spawn` of `claude`. */
  readonly run?: RunClaudeCli;
}

/** The binary the production runner spawns. */
const CLAUDE_BIN = "claude";

/** The answering-model id when neither modelUsage nor options.model is present. */
const MODEL_FALLBACK = "claude-code-cli";

/** The shape of the `claude --print --output-format json` stdout object. */
interface ClaudeCliResponse {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly subtype?: string;
  readonly modelUsage?: Record<string, unknown>;
}

export function claudeCliJudgeModel(
  options: ClaudeCliJudgeModelOptions = {},
): JudgeModelPort {
  const run = options.run ?? defaultRunClaudeCli;
  return {
    async complete(request: JudgeModelRequest): Promise<JudgeModelResponse> {
      const args = [
        "--print",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--system-prompt",
        request.system,
      ];
      // Omit --model by default so Claude Code uses its own configured default
      // (e.g. the Bedrock model); only pin it when --judge-model was passed.
      if (options.model !== undefined) {
        args.push("--model", options.model);
      }

      const { stdout, stderr, exitCode } = await run(args, request.user);
      if (exitCode !== 0) {
        throw new Error(`claude CLI exited ${exitCode}: ${stderr.trim()}`);
      }

      let parsed: ClaudeCliResponse;
      try {
        parsed = JSON.parse(stdout) as ClaudeCliResponse;
      } catch (err) {
        throw new Error(
          `claude CLI returned non-JSON stdout: ${(err as Error).message}`,
        );
      }
      const result = parsed.result;
      if (parsed.is_error === true || result === undefined) {
        throw new Error(
          `claude CLI did not return a usable result (subtype: ${String(parsed.subtype)})`,
        );
      }
      const usageKeys =
        parsed.modelUsage === undefined ? [] : Object.keys(parsed.modelUsage);
      const model = usageKeys[0] ?? options.model ?? MODEL_FALLBACK;
      return { text: result, model };
    },
  };
}

/**
 * The production runner: spawn `claude` with the given args, write the user
 * prompt to its stdin (async, since the prompt can be large), and capture
 * stdout, stderr, and the exit code. Uses `Bun.spawn` to match the repo idiom.
 */
const defaultRunClaudeCli: RunClaudeCli = async (args, input) => {
  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};
