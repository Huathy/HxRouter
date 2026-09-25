import { describe, expect, it } from "vitest";
import { readBoundedJson } from "../../src/lib/checkin/requestBody.js";

describe("check-in request body limit", () => {
  it("rejects a chunked body over the limit while streaming", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(40)));
          controller.enqueue(new TextEncoder().encode("x".repeat(40)));
          controller.close();
        },
      }),
    });
    await expect(readBoundedJson(request, 64)).resolves.toEqual({ error: "Request body is too large" });
  });

  it("parses a valid bounded body", async () => {
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ ok: true }) });
    await expect(readBoundedJson(request, 1024)).resolves.toEqual({ body: { ok: true } });
  });
});
