/**
 * The shared config-home resolver. Pure: the input is an env record and a home
 * path, the output is the harness's config home. Harness IDENTITY resolution is
 * the separate `resolveHarnessFromEnvironment` policy (covered by
 * harness-resolve.test.ts); this file covers only the config-home mapping both
 * instruments share.
 */
import { expect, test } from "bun:test";
import { harnessContract, resolveHarnessHome } from "../src/index.ts";

test("resolveHarnessHome honours the contract's config-home env var, else its default subdir", () => {
  const contract = harnessContract("codex");
  if (contract === undefined) throw new Error("missing codex contract");
  expect(
    resolveHarnessHome(contract, { CODEX_HOME: "/custom/codex" }, "/home/me"),
  ).toBe("/custom/codex");
  expect(resolveHarnessHome(contract, {}, "/home/me")).toBe("/home/me/.codex");
});
