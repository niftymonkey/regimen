import { test, expect, spyOn } from "bun:test";
import { httpExporter } from "../../src/exporter/http.ts";
import type { OtlpPayload } from "../../src/exporter/port.ts";

const PAYLOAD: OtlpPayload = { stream: "logs", data: { resourceLogs: [] } };

/** Send one payload to a local endpoint that answers every request with `status`. */
async function sendTo(status: number, body: string) {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { status }),
  });
  try {
    return await httpExporter({
      endpoint: `http://localhost:${server.port}/otlp`,
      authHeader: "Basic dGVzdA==",
    }).send(PAYLOAD);
  } finally {
    await server.stop(true);
  }
}

test("a 400 response is a rejected payload, which no retry can deliver", async () => {
  const result = await sendTo(400, "timestamp too old");

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.rejected).toBe(true);
  expect(result.error).toContain("HTTP 400");
  expect(result.error).toContain("timestamp too old");
});

test("a server error or an auth failure is a plain failure, left for a retry", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const result = await sendTo(status, "nope");

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(`HTTP ${status}`),
    });
  }
});

test("a long response body is cut short in the reported error", async () => {
  const result = await sendTo(400, "x".repeat(100_000));

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.length).toBeLessThan(1000);
  expect(result.error).toContain("HTTP 400");
  expect(result.error).toEndWith("(100000 chars in all)");
});

test("a 400 whose body cannot be read is still a rejected payload", async () => {
  // The status arrives intact, then the body stream fails partway, as when the
  // connection drops mid-body.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("connection reset"));
    },
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, { status: 400 }),
  );
  let result;
  try {
    result = await httpExporter({
      endpoint: "http://localhost/otlp",
      authHeader: "Basic dGVzdA==",
    }).send(PAYLOAD);
  } finally {
    fetchSpy.mockRestore();
  }

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.rejected).toBe(true);
  expect(result.error).toContain("HTTP 400");
});
