import { test, expect } from "bun:test";
import { recordingExporter } from "../../src/exporter/recording.ts";
import type { OtlpPayload } from "../../src/exporter/port.ts";

const logsPayload: OtlpPayload = { stream: "logs", data: { resourceLogs: [] } };
const tracesPayload: OtlpPayload = {
  stream: "traces",
  data: { resourceSpans: [] },
};

test("a sent payload is recorded and the send reports success", async () => {
  const exporter = recordingExporter();

  const result = await exporter.send(logsPayload);

  expect(result.ok).toBe(true);
  expect(exporter.sent).toEqual([logsPayload]);
});

test("payloads are recorded in call order across streams", async () => {
  const exporter = recordingExporter();

  await exporter.send(logsPayload);
  await exporter.send(tracesPayload);

  expect(exporter.sent.map((p) => p.stream)).toEqual(["logs", "traces"]);
});
