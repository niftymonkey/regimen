import { test, expect } from "bun:test";
import { bridgeLogPath, resolveDataDir } from "../src/data-dir.ts";

test("REGIMEN_DATA_DIR overrides the platform default", () => {
  expect(resolveDataDir({ REGIMEN_DATA_DIR: "/tmp/regimen-x" }, "linux")).toBe(
    "/tmp/regimen-x",
  );
});

test("linux falls back to XDG_DATA_HOME, then HOME", () => {
  expect(resolveDataDir({ XDG_DATA_HOME: "/x/data" }, "linux")).toBe(
    "/x/data/regimen",
  );
  expect(resolveDataDir({ HOME: "/home/mlo" }, "linux")).toBe(
    "/home/mlo/.local/share/regimen",
  );
});

test("an unresolvable environment throws rather than guessing", () => {
  expect(() => resolveDataDir({}, "linux")).toThrow();
});

test("the bridge log sits at the data directory root", () => {
  expect(bridgeLogPath("/x/data/regimen")).toBe("/x/data/regimen/bridge.log");
});
