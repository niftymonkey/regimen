/**
 * Enforcement's config-home resolution seam. Pure: the input is an env record
 * and a home path, the output is the harness's config home. Harness resolution
 * itself is the shared `resolveHarnessFromEnvironment` policy now (explicit
 * REGIMEN_HARNESS, else the CLI-set marker, else undefined), covered by the
 * shared package's tests; this file covers only the config-home resolver that
 * stays Enforcement-side.
 */
import { expect, test } from "bun:test";
import { resolveHarnessHome } from "../src/harness.ts";
import { harnessContract } from "@regimen/shared";

test("resolveHarnessHome honours the contract's config-home env var, else its default subdir", () => {
  const contract = harnessContract("codex");
  if (contract === undefined) throw new Error("missing codex contract");
  expect(
    resolveHarnessHome(contract, { CODEX_HOME: "/custom/codex" }, "/home/me"),
  ).toBe("/custom/codex");
  expect(resolveHarnessHome(contract, {}, "/home/me")).toBe("/home/me/.codex");
});
