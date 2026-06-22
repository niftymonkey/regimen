/**
 * The service-file byte encoding the CLI uses when laying down each platform's
 * supervisor file. Windows Task Scheduler's `schtasks /Create /XML` rejects
 * UTF-8 input ("unable to switch the encoding"), so the win32 plan must carry a
 * UTF-16-LE-with-BOM intent and `serviceFileBytes` must honour it; the systemd
 * unit and the launchd plist stay plain UTF-8 with no BOM. The platform branch
 * is exercised purely (the parameterized planner plus the encoder), never by
 * mocking `process.platform` at the write site.
 */
import { expect, test } from "bun:test";
import {
  planInstall,
  serviceFileBytes,
  type InstallContext,
} from "../src/cli/install/index.ts";

const CTX: InstallContext = {
  bunPath: "/home/mlo/.bun/bin/bun",
  loaderPath: "/home/mlo/dev/regimen-feedback/src/loader/run.ts",
  dataDir: "/home/mlo/.local/share/regimen",
};

const HOME = "/home/mlo";

test("the win32 plan carries UTF-16-LE-with-BOM service-file encoding", () => {
  expect(planInstall(CTX, "win32", HOME).serviceFileEncoding).toBe(
    "utf-16le-bom",
  );
});

test("the linux and darwin plans keep plain UTF-8 service-file encoding", () => {
  expect(planInstall(CTX, "linux", HOME).serviceFileEncoding).toBe("utf-8");
  expect(planInstall(CTX, "darwin", HOME).serviceFileEncoding).toBe("utf-8");
});

test("serviceFileBytes utf-16le-bom prepends the BOM and round-trips as UTF-16 LE", () => {
  const content = '<?xml version="1.0" encoding="UTF-16"?>\n<Task />\n';
  const bytes = serviceFileBytes(content, "utf-16le-bom");
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xfe);
  expect(bytes.subarray(2).toString("utf16le")).toBe(content);
});

test("serviceFileBytes utf-8 writes plain bytes with no BOM, byte-identical to UTF-8", () => {
  const content = "[Unit]\nDescription=Regimen Feedback loader\n";
  const bytes = serviceFileBytes(content, "utf-8");
  expect(bytes[0]).not.toBe(0xff);
  expect(bytes.equals(Buffer.from(content, "utf-8"))).toBe(true);
});
