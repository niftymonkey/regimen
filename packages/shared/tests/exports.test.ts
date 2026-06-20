import { expect, test } from "bun:test";
import {
  HARNESSES,
  asHarness,
  traceIdFor,
  resolveDataDir,
  dataDir,
  bufferDir,
  harnessContract,
} from "../src/index.ts";

test("the shared surface is exported", () => {
  expect(HARNESSES).toContain("claude");
  expect(asHarness("codex")).toBe("codex");
  expect(asHarness("nope")).toBeUndefined();
  expect(typeof traceIdFor).toBe("function");
  expect(typeof resolveDataDir).toBe("function");
  expect(typeof dataDir).toBe("function");
  expect(typeof bufferDir).toBe("function");
  expect(typeof harnessContract).toBe("function");
});
