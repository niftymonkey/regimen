/**
 * Enforcement's harness resolution seam. Pure: the input is an env record and a
 * home path, the output is the resolved harness or its config home. Enforcement
 * resolves the harness from REGIMEN_HARNESS only and fails closed; it never
 * detects the harness from a per-CLI env marker (that stays Feedback-private).
 */
import { expect, test } from "bun:test";
import { resolveHarness, resolveHarnessHome } from "../src/harness.ts";
import { harnessContract } from "@regimen/shared";

test("resolveHarness returns the harness named by REGIMEN_HARNESS", () => {
  expect(resolveHarness({ REGIMEN_HARNESS: "codex" })).toBe("codex");
});

test("resolveHarness returns undefined (fails closed) when REGIMEN_HARNESS is unset", () => {
  expect(resolveHarness({})).toBeUndefined();
  expect(resolveHarness({ REGIMEN_HARNESS: "" })).toBeUndefined();
});

test("resolveHarness ignores a per-CLI env marker; only REGIMEN_HARNESS resolves it", () => {
  // CLAUDECODE is Claude's presence marker; Feedback would detect it, but
  // Enforcement does not. With no REGIMEN_HARNESS it still fails closed.
  expect(resolveHarness({ CLAUDECODE: "1" })).toBeUndefined();
});

test("resolveHarness throws on an unknown REGIMEN_HARNESS value", () => {
  expect(() => resolveHarness({ REGIMEN_HARNESS: "bogus" })).toThrow(/bogus/);
});

test("resolveHarnessHome honours the contract's config-home env var, else its default subdir", () => {
  const contract = harnessContract("codex");
  if (contract === undefined) throw new Error("missing codex contract");
  expect(
    resolveHarnessHome(contract, { CODEX_HOME: "/custom/codex" }, "/home/me"),
  ).toBe("/custom/codex");
  expect(resolveHarnessHome(contract, {}, "/home/me")).toBe("/home/me/.codex");
});
