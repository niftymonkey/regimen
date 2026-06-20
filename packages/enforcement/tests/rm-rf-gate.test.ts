/**
 * The reference rm-rf discipline gate, spawned as a PreToolUse hook would invoke
 * it, against a temp REGIMEN_DATA_DIR. The gate must BLOCK a recursive forced rm
 * unconditionally (always emit the deny decision to the harness), and stamp the
 * recorded denial with the harness from REGIMEN_HARNESS. When REGIMEN_HARNESS is
 * unset it must still block, but skip the telemetry rather than stamp a wrong
 * harness like claude: no hardcoded harness in the gate.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "examples", "rm-rf-gate.ts");

const RM_RF_PAYLOAD = {
  hook_event_name: "PreToolUse",
  session_id: "sess-rmrf-1",
  tool_name: "Bash",
  tool_use_id: "toolu_rm01",
  tool_input: { command: "rm -rf /tmp/whatever" },
};

interface GateRun {
  readonly exit: number;
  readonly stdout: string;
  readonly events: Record<string, unknown>[];
}

/** Read the buffer's current segment into objects, in order. */
function readEvents(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, "buffer", "current.jsonl");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line));
}

/** Spawn the gate with the given env, returning its stdout, exit, and buffer. */
async function runGate(
  env: Record<string, string | undefined>,
): Promise<GateRun> {
  const dir = mkdtempSync(join(tmpdir(), "regimen-rmrf-gate-"));
  try {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      REGIMEN_DATA_DIR: dir,
      ...env,
    };
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) childEnv[key] = value;
    }
    const proc = Bun.spawn(["bun", GATE], {
      stdin: new TextEncoder().encode(JSON.stringify(RM_RF_PAYLOAD)),
      env: childEnv,
      stdout: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    return { exit, stdout, events: readEvents(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with REGIMEN_HARNESS set, the gate blocks and stamps that harness", async () => {
  const { exit, stdout, events } = await runGate({ REGIMEN_HARNESS: "codex" });
  expect(exit).toBe(0);

  const decision = JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");

  expect(events.length).toBe(1);
  expect(events[0]?.harness).toBe("codex");
});

test("with REGIMEN_HARNESS unset, the gate still blocks but records no denial", async () => {
  // Scrub every per-CLI marker too: the gate reads the baked REGIMEN_HARNESS
  // only and must never fall back to a hardcoded harness.
  const { exit, stdout, events } = await runGate({
    REGIMEN_HARNESS: undefined,
    CLAUDECODE: undefined,
    CODEX_THREAD_ID: undefined,
    GEMINI_CLI: undefined,
    COPILOT_CLI: undefined,
  });
  expect(exit).toBe(0);

  const decision = JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");

  // No harness present: block, but skip telemetry rather than stamp claude.
  expect(events).toHaveLength(0);
});
