/**
 * Enforcement's canonical published gate metadata: the gate ids it owns and how
 * each gate's command string is built from a clone path and the resolved
 * harness. This is the data the CLI installer consumes to wire Enforcement's
 * gates without reaching into Enforcement's internals. Every gate command, the
 * bun-run TS gate and the bash-run shell gates alike, carries
 * REGIMEN_HARNESS=<harness> so the running gate reads the harness the installer
 * detected rather than guessing, and the recorded denial is labelled correctly.
 * The harness is a parameter here, never a literal. Adding a gate is one entry
 * here.
 */
import { join } from "node:path";
import type { Harness } from "@regimen/shared";
import { assertSafeClonePath } from "./clone-path.ts";

/** A gate Enforcement can wire onto PreToolUse. */
export type GateId = "rm-rf" | "em-dash" | "inline-message";

/**
 * How each gate's command string is built from the clone path and the harness it
 * is being wired for. Order is the wire order within PreToolUse. The caller names
 * a GateId and never constructs a command, so the command shape stays owned here,
 * the one published place. Each builder validates the clone path before
 * interpolating it into its double-quoted shell string, so the export is
 * self-protecting for a direct consumer (the CLI) that has no planner to validate
 * first.
 */
export const GATE_COMMANDS: ReadonlyArray<{
  readonly id: GateId;
  readonly command: (clonePath: string, harness: Harness) => string;
}> = [
  {
    id: "rm-rf",
    command: (c, harness) => {
      assertSafeClonePath(c);
      return `REGIMEN_HARNESS=${harness} bun "${join(c, "examples", "rm-rf-gate.ts")}"`;
    },
  },
  {
    id: "em-dash",
    command: (c, harness) => {
      assertSafeClonePath(c);
      return `REGIMEN_HARNESS=${harness} bash "${join(c, "examples", "em-dash-gate.sh")}"`;
    },
  },
  {
    id: "inline-message",
    command: (c, harness) => {
      assertSafeClonePath(c);
      return `REGIMEN_HARNESS=${harness} bash "${join(c, "examples", "inline-message-guard.sh")}"`;
    },
  },
];
