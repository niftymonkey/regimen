/**
 * The published gate metadata: ids and the command string each gate builds from
 * a clone path and the resolved harness. Exercised directly as data; no
 * filesystem. The harness is a parameter, not a literal: the shell gates carry
 * REGIMEN_HARNESS=<harness> so the recorded denial is labelled correctly.
 */
import { expect, test } from "bun:test";
import { GATE_COMMANDS, type GateId } from "../src/install/gate-commands.ts";

const CLONE = "/home/me/regimen-enforcement";

test("GATE_COMMANDS lists the three gates in catalog order", () => {
  expect(GATE_COMMANDS.map((g) => g.id)).toEqual([
    "rm-rf",
    "em-dash",
    "inline-message",
  ]);
});

test("each gate builds the documented command from the clone path and harness", () => {
  const byId = (id: GateId): string => {
    const spec = GATE_COMMANDS.find((g) => g.id === id);
    if (spec === undefined) throw new Error(`missing gate ${id}`);
    return spec.command(CLONE, "codex");
  };
  expect(byId("rm-rf")).toBe(`bun "${CLONE}/examples/rm-rf-gate.ts"`);
  expect(byId("em-dash")).toBe(
    `REGIMEN_HARNESS=codex bash "${CLONE}/examples/em-dash-gate.sh"`,
  );
  expect(byId("inline-message")).toBe(
    `REGIMEN_HARNESS=codex bash "${CLONE}/examples/inline-message-guard.sh"`,
  );
});

test("the shell gates carry the resolved harness, not a hardcoded codex", () => {
  const byId = (id: GateId): string => {
    const spec = GATE_COMMANDS.find((g) => g.id === id);
    if (spec === undefined) throw new Error(`missing gate ${id}`);
    return spec.command(CLONE, "claude");
  };
  expect(byId("em-dash")).toBe(
    `REGIMEN_HARNESS=claude bash "${CLONE}/examples/em-dash-gate.sh"`,
  );
  expect(byId("inline-message")).toBe(
    `REGIMEN_HARNESS=claude bash "${CLONE}/examples/inline-message-guard.sh"`,
  );
});

test("a builder called directly with an unsafe clone path throws (self-protecting export)", () => {
  // GATE_COMMANDS is consumed directly by the CLI, with no planner to validate
  // first, so each builder must reject a path that could break out of the
  // double-quoted shell context on its own.
  for (const builder of GATE_COMMANDS.map((g) => g.command)) {
    expect(() => builder("/tmp/$(touch pwned)/repo", "codex")).toThrow();
    expect(() => builder("/tmp/`touch pwned`/repo", "codex")).toThrow();
  }
});
