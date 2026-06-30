/**
 * Argument parsing for `regimen assess --all`: the batch-size flag. Pure parsing
 * exercised directly, no store and no judge. The positive-integer guard is the
 * load-bearing case: a zero or negative batch would stall the sweep's loop.
 */
import { expect, test } from "bun:test";
import { DEFAULT_BATCH_SIZE, parseBatchSize } from "../src/cli/index.ts";

test("parseBatchSize defaults to DEFAULT_BATCH_SIZE when --batch is absent", () => {
  expect(parseBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
});

test("parseBatchSize parses a positive integer", () => {
  expect(parseBatchSize("3")).toBe(3);
});

test("parseBatchSize falls back to the default for zero, negative, or non-numeric values", () => {
  expect(parseBatchSize("0")).toBe(DEFAULT_BATCH_SIZE);
  expect(parseBatchSize("-4")).toBe(DEFAULT_BATCH_SIZE);
  expect(parseBatchSize("abc")).toBe(DEFAULT_BATCH_SIZE);
  expect(parseBatchSize("2.5")).toBe(DEFAULT_BATCH_SIZE);
});
