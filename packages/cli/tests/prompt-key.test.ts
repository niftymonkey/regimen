/**
 * The single-keypress between-batch mapping for `assess --all` (`keyToDecision`),
 * exercised directly, plus `promptNextBatch`'s non-interactive branch: a run with
 * no TTY must stop after the batch rather than wait for input or judge on, the
 * load-bearing guard against an unbounded bill on a piped or backgrounded sweep.
 */
import { expect, test } from "bun:test";
import { keyToDecision, promptNextBatch } from "../src/cli/index.ts";

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

test("promptNextBatch stops with quit and says so when stdin is not a TTY", async () => {
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const savedIsTTY = stdin.isTTY;
  const savedWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  // Force the non-interactive branch deterministically.
  stdin.isTTY = false;
  try {
    const decision = await promptNextBatch();
    expect(decision).toBe("quit");
    expect(out).toContain("non-interactive");
  } finally {
    process.stdout.write = savedWrite;
    stdin.isTTY = savedIsTTY;
  }
});
