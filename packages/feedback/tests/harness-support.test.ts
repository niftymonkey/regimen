import { expect, test } from "bun:test";
import { harnessSupport } from "../src/harness/support.ts";

test("harnessSupport(codex) returns a bundle with descriptor, reader, resolver", () => {
  const support = harnessSupport("codex");
  expect(support).toBeDefined();
  expect(support?.descriptor.contract.harness).toBe("codex");
  expect(typeof support?.reader.read).toBe("function");
  expect(typeof support?.resolver.resolveCurrent).toBe("function");
  expect(typeof support?.resolver.locate).toBe("function");
});

test("harnessSupport for a valid-but-unregistered harness returns undefined", () => {
  expect(harnessSupport("gemini")).toBeUndefined();
});
