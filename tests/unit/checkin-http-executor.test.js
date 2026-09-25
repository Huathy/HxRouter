import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHttpCheckin } from "../../src/lib/checkin/httpCheckinExecutor.js";

const config = {
  url: "https://example.com/api/check-in",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer {{secret}}",
  },
  body: '{"token":"{{secret}}"}',
  expectedStatus: [200],
  successPattern: "success|已签到",
  timeoutSeconds: 30,
};

describe("HTTP check-in executor", () => {
  it("substitutes the secret and returns a redacted result", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "success", echoed: "secret-token" }), { status: 200 }));
    const result = await executeHttpCheckin({ config, secret: "secret-token" }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.com/api/check-in");
    expect(options.redirect).toBe("manual");
    expect(options.headers.Authorization).toBe("Bearer secret-token");
    expect(options.body).toBe('{"token":"secret-token"}');
    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.responsePreview).not.toContain("secret-token");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expands {{date}} in the configured timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T16:30:00Z"));
    const fetchImpl = vi.fn(async () => new Response("success", { status: 200 }));
    await executeHttpCheckin({
      config: { ...config, body: '{"date":"{{date}}"}' },
      secret: "",
      timezone: "Asia/Shanghai",
    }, { fetchImpl });

    expect(fetchImpl.mock.calls[0][1].body).toBe('{"date":"2026-09-25"}');
  });

  it("redacts URL-encoded secret variants", async () => {
    const secret = "a b/中文";
    const fetchImpl = vi.fn(async () => new Response(`success ${encodeURIComponent(secret)} ${encodeURIComponent(encodeURIComponent(secret))}`, { status: 200 }));
    const result = await executeHttpCheckin({
      config: { ...config, successPattern: "success" },
      secret,
    }, { fetchImpl });

    expect(result.responsePreview).not.toContain(encodeURIComponent(secret));
    expect(result.responsePreview).not.toContain(encodeURIComponent(encodeURIComponent(secret)));
  });

  it("fails when the response does not match the success pattern", async () => {
    const fetchImpl = vi.fn(async () => new Response("not checked in", { status: 200 }));
    const result = await executeHttpCheckin({ config, secret: "secret-token" }, { fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("UNEXPECTED_RESPONSE");
  });

  it("rejects oversized responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(262145), { status: 200 }));
    const result = await executeHttpCheckin({ config, secret: "secret-token" }, { fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("RESPONSE_TOO_LARGE");
  });
});
