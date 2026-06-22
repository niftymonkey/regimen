/**
 * The Claude Code CLI adapter (claudeCliJudgeModel), a second production
 * JudgeModelPort that shells out to `claude --print` reusing the engineer's
 * configured auth. Built and tested thinnest: a fake RunClaudeCli is injected at
 * the spawn boundary so the suite makes ZERO real spawn. The real `claude`
 * round-trip is a separate manual validation, never part of the build.
 */
import { expect, test } from "bun:test";
import {
  claudeCliJudgeModel,
  type ClaudeCliResult,
  type RunClaudeCli,
} from "../src/judged/claude-cli-adapter.ts";

/** One captured invocation the fake runner recorded. */
interface CapturedRun {
  args: ReadonlyArray<string>;
  input: string;
}

/**
 * A fake RunClaudeCli that records the one call and returns a canned result. No
 * spawn: it resolves to a ClaudeCliResult shape directly.
 */
function fakeRun(
  captured: CapturedRun[],
  result: ClaudeCliResult,
): RunClaudeCli {
  return (args, input) => {
    captured.push({ args, input });
    return Promise.resolve(result);
  };
}

/** A successful `claude --print --output-format json` stdout payload. */
const CLI_RESPONSE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"intent":{"value":"feature"}}',
  modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 20 },
  },
});

function ok(stdout: string): ClaudeCliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

test("the adapter builds the print argv, pipes the user to stdin, and returns result plus the answering model", async () => {
  const captured: CapturedRun[] = [];
  const llm = claudeCliJudgeModel({ run: fakeRun(captured, ok(CLI_RESPONSE)) });

  const response = await llm.complete({
    system: "you are the judge",
    user: "the conversation chunks",
  });

  expect(response.text).toBe('{"intent":{"value":"feature"}}');
  expect(response.model).toBe("claude-haiku-4-5-20251001");

  expect(captured).toHaveLength(1);
  const call = captured[0]!;
  expect(call.args).toEqual([
    "--print",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--system-prompt",
    "you are the judge",
  ]);
  expect(call.input).toBe("the conversation chunks");
});

test("the adapter omits --model by default and includes it when options.model is set", async () => {
  const withoutCaptured: CapturedRun[] = [];
  const withoutModel = claudeCliJudgeModel({
    run: fakeRun(withoutCaptured, ok(CLI_RESPONSE)),
  });
  await withoutModel.complete({ system: "s", user: "u" });
  expect(withoutCaptured[0]!.args).not.toContain("--model");

  const withCaptured: CapturedRun[] = [];
  const withModel = claudeCliJudgeModel({
    model: "claude-sonnet-4-6",
    run: fakeRun(withCaptured, ok(CLI_RESPONSE)),
  });
  await withModel.complete({ system: "s", user: "u" });
  const args = withCaptured[0]!.args;
  const modelIndex = args.indexOf("--model");
  expect(modelIndex).toBeGreaterThanOrEqual(0);
  expect(args[modelIndex + 1]).toBe("claude-sonnet-4-6");
});

test("the adapter throws including the trimmed stderr on a non-zero exit", async () => {
  const captured: CapturedRun[] = [];
  const llm = claudeCliJudgeModel({
    run: fakeRun(captured, {
      stdout: "",
      stderr: "  claude: auth failed  \n",
      exitCode: 1,
    }),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(
    /claude: auth failed/,
  );
});

test("the adapter throws a clear error when stdout is not JSON", async () => {
  const captured: CapturedRun[] = [];
  const llm = claudeCliJudgeModel({
    run: fakeRun(captured, ok("not json at all")),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(
    /claude CLI/,
  );
});

test("the adapter throws mentioning subtype when is_error is true", async () => {
  const captured: CapturedRun[] = [];
  const llm = claudeCliJudgeModel({
    run: fakeRun(
      captured,
      ok(
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: "partial",
        }),
      ),
    ),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(
    /error_max_turns/,
  );
});

test("the adapter throws mentioning subtype when result is undefined", async () => {
  const captured: CapturedRun[] = [];
  const llm = claudeCliJudgeModel({
    run: fakeRun(
      captured,
      ok(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
        }),
      ),
    ),
  });

  await expect(llm.complete({ system: "s", user: "u" })).rejects.toThrow(
    /success/,
  );
});

test("model falls back to options.model then a constant when modelUsage is absent", async () => {
  const noUsage = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "{}",
  });

  const withModel = claudeCliJudgeModel({
    model: "claude-sonnet-4-6",
    run: fakeRun([], ok(noUsage)),
  });
  expect((await withModel.complete({ system: "s", user: "u" })).model).toBe(
    "claude-sonnet-4-6",
  );

  const withoutModel = claudeCliJudgeModel({ run: fakeRun([], ok(noUsage)) });
  expect((await withoutModel.complete({ system: "s", user: "u" })).model).toBe(
    "claude-code-cli",
  );
});
