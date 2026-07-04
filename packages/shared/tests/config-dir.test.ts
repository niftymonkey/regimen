import { expect, test } from "bun:test";
import { resolveConfigDir } from "@regimen/shared";

test("REGIMEN_CONFIG_DIR wins over any OS default", () => {
  const result = resolveConfigDir(
    { REGIMEN_CONFIG_DIR: "/explicit/override" },
    "linux",
  );
  expect(result).toBe("/explicit/override");
});

test("on Linux, XDG_CONFIG_HOME/regimen is the config dir when XDG_CONFIG_HOME is set", () => {
  const result = resolveConfigDir(
    { XDG_CONFIG_HOME: "/xdg/config", HOME: "/home/eng" },
    "linux",
  );
  expect(result).toBe("/xdg/config/regimen");
});

test("on Linux, ~/.config/regimen is the fallback when XDG_CONFIG_HOME is unset", () => {
  const result = resolveConfigDir({ HOME: "/home/eng" }, "linux");
  expect(result).toBe("/home/eng/.config/regimen");
});

test("on macOS, ~/.config/regimen is the config dir", () => {
  const result = resolveConfigDir({ HOME: "/Users/eng" }, "darwin");
  expect(result).toBe("/Users/eng/.config/regimen");
});

test("on Windows, %APPDATA%\\regimen is the config dir", () => {
  const result = resolveConfigDir(
    { APPDATA: "C:\\Users\\eng\\AppData\\Roaming" },
    "win32",
  );
  expect(result).toBe("C:\\Users\\eng\\AppData\\Roaming\\regimen");
});

test("an unrecognized platform throws an error naming the platform", () => {
  expect(() => resolveConfigDir({}, "haiku")).toThrow(/haiku/);
});
