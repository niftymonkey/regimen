/**
 * The clone-path safety check (pure). Exercised directly: it rejects a path that
 * could break out of the double-quoted POSIX-shell context the path is
 * interpolated into. Beyond rejecting the right paths, the thrown message must be
 * safe to print: a control byte in the offending value is JSON-escaped, never
 * leaked raw into terminal or log output, on EVERY branch.
 */
import { expect, test } from "bun:test";
import { assertSafeClonePath } from "../src/install/clone-path.ts";

const ESC = String.fromCharCode(0x1b);

test("a shell-unsafe path is rejected", () => {
  expect(() => assertSafeClonePath("/tmp/$(touch pwned)/repo")).toThrow();
  expect(() => assertSafeClonePath("/tmp/`x`/repo")).toThrow();
});

test("a safe path is accepted", () => {
  expect(() => assertSafeClonePath("/home/me/regimen")).not.toThrow();
  expect(() =>
    assertSafeClonePath("/tmp/john's Backup (old)/regimen"),
  ).not.toThrow();
});

test("the shell-unsafe-character message does not leak a raw control byte", () => {
  // A path that trips the shell-unsafe branch ($) while also carrying a control
  // byte (ESC): the message must not contain the raw ESC, it must be escaped.
  let message = "";
  try {
    assertSafeClonePath(`/tmp/$${ESC}/repo`);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).not.toContain(ESC);
  expect(message).toContain("\\u001b");
});

test("the control-character message does not leak a raw control byte", () => {
  let message = "";
  try {
    assertSafeClonePath(`/tmp/${ESC}/repo`);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).not.toContain(ESC);
  expect(message).toContain("\\u001b");
});
