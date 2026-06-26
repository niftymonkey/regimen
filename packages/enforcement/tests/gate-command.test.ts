/**
 * The surviving gate command-builder: how an authored gate body becomes the
 * shell command a harness hooks file runs. Exercised directly as a pure
 * function; no filesystem. The harness is a parameter, not a literal, so the
 * running gate reads the harness the installer detected. The interpolated path is
 * forward-slashed so the command survives a POSIX-style shell on native Windows,
 * and the clone path is validated so a shell-unsafe path is rejected.
 */
import { expect, test } from "bun:test";
import { buildGateCommand } from "../src/install/gate-command.ts";

const CLONE = "/home/me/regimen";
const SCRIPT = "tests/fixtures/rm-rf-gate.ts";

test("the command runs the authored body under bun, carrying the resolved harness", () => {
  expect(buildGateCommand(CLONE, SCRIPT, "codex")).toBe(
    `REGIMEN_HARNESS=codex bun "${CLONE}/${SCRIPT}"`,
  );
  expect(buildGateCommand(CLONE, SCRIPT, "claude")).toBe(
    `REGIMEN_HARNESS=claude bun "${CLONE}/${SCRIPT}"`,
  );
});

test("a Windows-style clone path is forward-slashed so the command survives a POSIX shell", () => {
  const command = buildGateCommand(
    "C:\\Users\\me\\regimen",
    "tests\\fixtures\\rm-rf-gate.ts",
    "codex",
  );
  expect(command).not.toContain("\\");
  expect(command).toContain(
    'bun "C:/Users/me/regimen/tests/fixtures/rm-rf-gate.ts"',
  );
});

test("a clone path with a space stays one double-quoted argument", () => {
  const spaced = "/tmp/clone path/regimen";
  expect(buildGateCommand(spaced, SCRIPT, "codex")).toBe(
    `REGIMEN_HARNESS=codex bun "${spaced}/${SCRIPT}"`,
  );
});

test("a shell-unsafe clone path is rejected before it reaches the command string", () => {
  expect(() =>
    buildGateCommand("/tmp/$(touch pwned)/repo", SCRIPT, "codex"),
  ).toThrow();
  expect(() =>
    buildGateCommand("/tmp/`touch pwned`/repo", SCRIPT, "codex"),
  ).toThrow();
});

test("a scriptPath with a `..` segment that escapes the clone is rejected", () => {
  expect(() =>
    buildGateCommand(CLONE, "../../../etc/passwd", "codex"),
  ).toThrow();
  expect(() =>
    buildGateCommand(CLONE, "tests/../../escape.ts", "codex"),
  ).toThrow();
});

test("an absolute scriptPath is rejected so it cannot point outside the clone", () => {
  expect(() => buildGateCommand(CLONE, "/etc/passwd", "codex")).toThrow();
});

test("a clone path with a redundant `.` segment still accepts a body under it", () => {
  // The containment check must canonicalize both sides. A clonePath carrying a `.`
  // segment (or a redundant separator) is the same directory as its normalized
  // form, so a normal relative body under it is inside the clone and must not be
  // falsely rejected. The emitted command uses the canonicalized clone root.
  const dotted = "/home/me/./regimen";
  expect(buildGateCommand(dotted, SCRIPT, "codex")).toBe(
    `REGIMEN_HARNESS=codex bun "${CLONE}/${SCRIPT}"`,
  );
});

test("a normal relative scriptPath under the clone is accepted", () => {
  expect(buildGateCommand(CLONE, SCRIPT, "codex")).toBe(
    `REGIMEN_HARNESS=codex bun "${CLONE}/${SCRIPT}"`,
  );
});
