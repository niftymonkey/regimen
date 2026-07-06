/**
 * The Regimen-owned config file: `KEY=value` settings that live beside the
 * installed CLI (under the config dir resolved by `@regimen/shared`) instead
 * of the user's shell profile. Loaded once at CLI startup, at the top of
 * `runCli`, so every `regimen` subcommand sees it applied before dispatch.
 * The real environment always wins: a variable already set in `target` is
 * left untouched. A missing or unreadable file is a silent no-op, a config
 * file must never break the CLI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The commented env template dropped at `${dir}/env` on install when that
 * file is absent. Every line is a comment, so the file has no effect on its
 * own; the judge vars it documents only apply once the reader uncomments and
 * fills in a value.
 */
const ENV_TEMPLATE = `# Regimen judge configuration, loaded at CLI startup. Real environment variables always win over this file.
#
# REGIMEN_JUDGE_API_KEY= the API key for the judge model's provider, any OpenAI-compatible endpoint including Anthropic
# REGIMEN_JUDGE_BASE_URL= the judge endpoint; a keyless local endpoint such as Ollama works too
# REGIMEN_JUDGE_MODEL= the judge model name
`;

/**
 * Write a commented env template to `${dir}/env` when that file does not
 * exist. Never touches a file that already exists, even an empty one, so
 * user configuration is never overwritten. Under `dryRun`, prints what it
 * would do and writes nothing. Returns whether it wrote.
 */
export function writeEnvTemplateIfAbsent(
  dir: string,
  dryRun: boolean,
): boolean {
  const path = join(dir, "env");
  if (existsSync(path)) return false;
  if (dryRun) {
    process.stdout.write(`would write an env template at ${path}\n`);
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, ENV_TEMPLATE);
  return true;
}

/**
 * Parse `KEY=value` lines. `#` comments and blank lines are ignored. Each
 * value is trimmed and taken literally, no quoting semantics. A line without
 * an `=`, or with an empty key, is skipped. A value containing `=` splits on
 * the first `=` only.
 */
export function parseEnvFile(
  contents: string,
): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex < 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (key === "") continue;
    const value = line.slice(eqIndex + 1).trim();
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * Load `${dir}/env` and apply each parsed entry onto `target` when that key
 * is not already set. Never throws: a missing file or any read error is a
 * silent no-op.
 */
export function loadEnvFile(
  dir: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  let contents: string;
  try {
    contents = readFileSync(join(dir, "env"), "utf8");
  } catch {
    return;
  }
  for (const { key, value } of parseEnvFile(contents)) {
    if (target[key] === undefined) target[key] = value;
  }
}
