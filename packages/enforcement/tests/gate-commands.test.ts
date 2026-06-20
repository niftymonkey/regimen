/**
 * The published gate metadata: ids and the Codex command string each gate
 * builds from a clone path. Exercised directly as data; no filesystem.
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

test("each gate builds the documented Codex command from the clone path", () => {
  const byId = (id: GateId): string => {
    const spec = GATE_COMMANDS.find((g) => g.id === id);
    if (spec === undefined) throw new Error(`missing gate ${id}`);
    return spec.command(CLONE);
  };
  expect(byId("rm-rf")).toBe(`bun "${CLONE}/examples/rm-rf-gate-codex.ts"`);
  expect(byId("em-dash")).toBe(
    `REGIMEN_HARNESS=codex bash "${CLONE}/examples/em-dash-gate.sh"`,
  );
  expect(byId("inline-message")).toBe(
    `REGIMEN_HARNESS=codex bash "${CLONE}/examples/inline-message-guard.sh"`,
  );
});

test("a builder called directly with an unsafe clone path throws (self-protecting export)", () => {
  // GATE_COMMANDS is consumed directly by the CLI, with no planner to validate
  // first, so each builder must reject a path that could break out of the
  // double-quoted shell context on its own.
  for (const builder of GATE_COMMANDS.map((g) => g.command)) {
    expect(() => builder("/tmp/$(touch pwned)/repo")).toThrow();
    expect(() => builder("/tmp/`touch pwned`/repo")).toThrow();
  }
});
