/**
 * Enforcement's canonical published gate metadata: the gate ids it owns and how
 * each gate's Codex command string is built from a clone path. This is the data
 * the CLI installer (a later step) consumes to wire Enforcement's gates without
 * reaching into Enforcement's internals. The TS gate runs under bun and
 * self-stamps its harness; the shell gates run under bash, need
 * REGIMEN_HARNESS=codex for the recorded harness label, and rely on jq. Adding a
 * gate is one entry here.
 */
import { join } from "node:path";
import { assertSafeClonePath } from "./clone-path.ts";

/** A gate Enforcement can wire onto PreToolUse. */
export type GateId = "rm-rf" | "em-dash" | "inline-message";

/**
 * How each gate's command string is built from the clone path. Order is the wire
 * order within PreToolUse. The caller names a GateId and never constructs a
 * command, so the command shape stays owned here, the one published place. Each
 * builder validates the clone path before interpolating it into its double-quoted
 * shell string, so the export is self-protecting for a direct consumer (the CLI)
 * that has no planner to validate first.
 */
export const GATE_COMMANDS: ReadonlyArray<{
  readonly id: GateId;
  readonly command: (clonePath: string) => string;
}> = [
  {
    id: "rm-rf",
    command: (c) => {
      assertSafeClonePath(c);
      return `bun "${join(c, "examples", "rm-rf-gate-codex.ts")}"`;
    },
  },
  {
    id: "em-dash",
    command: (c) => {
      assertSafeClonePath(c);
      return `REGIMEN_HARNESS=codex bash "${join(c, "examples", "em-dash-gate.sh")}"`;
    },
  },
  {
    id: "inline-message",
    command: (c) => {
      assertSafeClonePath(c);
      return `REGIMEN_HARNESS=codex bash "${join(c, "examples", "inline-message-guard.sh")}"`;
    },
  },
];
