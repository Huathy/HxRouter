import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(async () => new Response("ok")),
  initTranslators: vi.fn(async () => {}),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: mocks.initTranslators }));

describe("responses request signal forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleChat.mockImplementation(async () => new Response("ok"));
  });

  it("preserves client abort on the patched responses request", async () => {
    const { POST } = await import("../../src/app/api/v1/responses/route.js");
    const controller = new AbortController();
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4", input: "hello" }),
      signal: controller.signal,
    });

    await POST(request);
    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(forwarded.signal).toBeDefined();
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });

  it("preserves client abort on the patched compact request", async () => {
    const { POST } = await import("../../src/app/api/v1/responses/compact/route.js");
    const controller = new AbortController();
    const request = new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4", input: "hello" }),
      signal: controller.signal,
    });

    await POST(request);
    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(forwarded.signal).toBeDefined();
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });
});
