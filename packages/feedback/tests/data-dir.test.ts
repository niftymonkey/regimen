import { expect, test } from "bun:test";
import { bufferDir, resolveDataDir } from "../src/data-dir.ts";

test("REGIMEN_DATA_DIR wins over any OS default", () => {
  const result = resolveDataDir(
    { REGIMEN_DATA_DIR: "/explicit/override" },
    "linux",
  );
  expect(result).toBe("/explicit/override");
});

test("on Linux, XDG_DATA_HOME/regimen is the data dir when XDG_DATA_HOME is set", () => {
  const result = resolveDataDir(
    { XDG_DATA_HOME: "/xdg/data", HOME: "/home/eng" },
    "linux",
  );
  expect(result).toBe("/xdg/data/regimen");
});

test("on Linux, ~/.local/share/regimen is the fallback when XDG_DATA_HOME is unset", () => {
  const result = resolveDataDir({ HOME: "/home/eng" }, "linux");
  expect(result).toBe("/home/eng/.local/share/regimen");
});

test("on macOS, ~/Library/Application Support/regimen is the data dir", () => {
  const result = resolveDataDir({ HOME: "/Users/eng" }, "darwin");
  expect(result).toBe("/Users/eng/Library/Application Support/regimen");
});

test("on Windows, %APPDATA%\\regimen is the data dir", () => {
  const result = resolveDataDir(
    { APPDATA: "C:\\Users\\eng\\AppData\\Roaming" },
    "win32",
  );
  expect(result).toBe("C:\\Users\\eng\\AppData\\Roaming\\regimen");
});

test("an unrecognized platform throws an error naming the platform", () => {
  expect(() => resolveDataDir({}, "haiku")).toThrow(/haiku/);
});

test("bufferDir returns <dataDir>/buffer", () => {
  expect(bufferDir("/var/regimen")).toBe("/var/regimen/buffer");
});
