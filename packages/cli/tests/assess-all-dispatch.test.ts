/**
 * The `regimen assess --all` DISPATCH: argv routes to the bulk sweep facade
 * rather than the single-session judge. Driven in-process through runCli against
 * a temp data dir with an empty store, so no real conversation is judged and the
 * host store is never touched. The judge backend is pinned to a LOCAL mock so
 * resolving it succeeds; with zero conversations it is never actually called.
 * The interactive between-batch prompt is not reached (nothing to judge).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";

const MANAGED_ENV = [
  "REGIMEN_DATA_DIR",
  "REGIMEN_HARNESS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

let savedEnv: Record<string, string | undefined>;
let savedWrite: typeof process.stdout.write;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  savedWrite = process.stdout.write.bind(process.stdout);
});

afterEach(() => {
  process.stdout.write = savedWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regimen-sweep-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

function startMockAnthropic(): { baseUrl: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "{}" }],
        stop_reason: "end_turn",
      });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

test("regimen assess --all routes to the bulk sweep and reports an empty store", async () => {
  const dataDir = tempDataDir();
  const mock = startMockAnthropic();
  process.env.REGIMEN_DATA_DIR = dataDir;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await runCli(["assess", "--all"]);
    expect(exit).toBe(0);
    // The sweep accounting, not the single-session judge (which would fail to
    // resolve a current session against an empty store).
    expect(stdout).toContain("matched 0");
    expect(stdout).toContain("to judge 0");
  } finally {
    mock.stop();
  }
});
