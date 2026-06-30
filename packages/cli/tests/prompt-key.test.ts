/**
 * The single-keypress between-batch mapping for `assess --all`. Pure mapping,
 * exercised directly; the raw-stdin plumbing around it is thin I/O glue.
 */
import { expect, test } from "bun:test";
import { keyToDecision } from "../src/cli/index.ts";

const CTRL_C = String.fromCharCode(3);

test("keyToDecision maps c to continue", () => {
  expect(keyToDecision("c")).toBe("continue");
});

test("keyToDecision maps a to all and q to quit", () => {
  expect(keyToDecision("a")).toBe("all");
  expect(keyToDecision("q")).toBe("quit");
});

test("keyToDecision treats Enter as continue and Ctrl-C as quit", () => {
  expect(keyToDecision("\r")).toBe("continue");
  expect(keyToDecision("\n")).toBe("continue");
  expect(keyToDecision(CTRL_C)).toBe("quit");
});

test("keyToDecision is case-insensitive and ignores unrecognized keys", () => {
  expect(keyToDecision("C")).toBe("continue");
  expect(keyToDecision("A")).toBe("all");
  expect(keyToDecision("x")).toBeUndefined();
  expect(keyToDecision("[A")).toBeUndefined();
});
