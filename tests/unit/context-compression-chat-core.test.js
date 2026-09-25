import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock, compressionMocks } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  compressionMocks: {
    compressContext: vi.fn(),
    formatCompressionLog: vi.fn((stats) => stats ? "estimated token delta=90 before=100 after=10 (90.0%)" : null),
    formatCompressionSizeLog: vi.fn(() => "body=100B→20B messages=80B→10B"),
    isCompressionPhantomSavings: vi.fn(() => false),
    resolveCompressionSessionKey: vi.fn(() => "tenant:conn:session"),
  },
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  finishPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/rtk/contextCompression.js", () => compressionMocks);

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore local compression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compressionMocks.compressContext.mockImplementation(async (body) => {
      body.messages[0].content = "compressed context";
      return { tokens_before: 100, tokens_after: 10, tokens_saved: 90 };
    });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("passes local compression diagnostics to logs and the executor", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "original context" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      compressionEnabled: true,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(compressionMocks.compressContext).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      enabled: true,
      format: "openai",
      sessionKey: "tenant:conn:session",
    }));
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        messages: [{ role: "user", content: "compressed context" }],
      }),
    }));
    expect(log.info).toHaveBeenCalledWith("COMPRESSION", expect.stringContaining("estimated token delta"));
  });

  it("fails open with a compression diagnostic when the local engine is unavailable", async () => {
    compressionMocks.compressContext.mockResolvedValue(null);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "original context" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      compressionEnabled: true,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(log.warn).toHaveBeenCalledWith("COMPRESSION", expect.stringContaining("skipped"));
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        messages: [{ role: "user", content: "original context" }],
      }),
    }));
  });
});
