// L1-5: combo strategy vocabulary validation (open-sse/services/combo.js)
// L1-6: modality strip must be visible and deduplicated (open-sse/handlers/chatCore.js)
//
// The dedup assertions matter more than the warn itself: log.warn is not
// request-gated, so an undeduplicated warning would print on every request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

// ── chatCore harness (mirrors tests/unit/force-stream-config.test.js) ──────────
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/contextCompression.js", () => ({
  compressContext: vi.fn(async () => null),
  formatCompressionLog: vi.fn(() => null),
  formatCompressionSizeLog: vi.fn(() => ""),
  isCompressionPhantomSavings: vi.fn(() => false),
  resolveCompressionSessionKey: vi.fn(() => "test-session"),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({ vision: true, pdf: true, audioInput: true })),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => true),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  saveUsageStats: vi.fn(),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  finishPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const ALL_CAPS = { vision: true, pdf: true, audioInput: true };
const NO_CAPS = { vision: false, pdf: false, audioInput: false };

// The executor is never reached by a passing assertion here; reject so the chat
// error path does not dereference a missing response. chatCore reports that
// rejection with a bare console.log (chatCore.js:618), so swallow console output
// for this file — every assertion reads the injected log mock, not stdout.
// Only the console spy is restored: a blanket vi.restoreAllMocks() would also
// strip the implementations the vi.mock factories above rely on.
let consoleLogSpy;

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockRejectedValue(new Error("boom"));
  getCapabilitiesForModel.mockReturnValue(ALL_CAPS);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy?.mockRestore();
});

// ── L1-5: combo strategy vocabulary ───────────────────────────────────────────
const okResponse = () => new Response("ok", { status: 200 });
const freshLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });

async function dispatch({ comboName, strategy, models, body }) {
  const log = freshLog();
  const res = await handleComboChat({
    body,
    models,
    comboName,
    comboStrategy: strategy,
    handleSingleModel: vi.fn(async () => okResponse()),
    log,
    timeoutMs: 0,
  });
  return { log, res };
}

const comboWarnings = (log) => log.warn.mock.calls.filter(([tag]) => tag === "COMBO");
const TTS_MODELS = ["elevenlabs/eleven_multilingual_v2"];

describe("combo strategy vocabulary validation (L1-5)", () => {
  it("warns once for a chat-only strategy on a non-chat modality, and stays quiet on re-dispatch", async () => {
    const { log, res } = await dispatch({
      comboName: "dedup-tts-fusion",
      strategy: "fusion",
      models: TTS_MODELS,
      body: { model: "dedup-tts-fusion", input: "read this aloud" },
    });

    expect(res.status).toBe(200);
    const warnings = comboWarnings(log);
    expect(warnings).toHaveLength(1);
    const [, message] = warnings[0];
    expect(message).toContain("dedup-tts-fusion");
    expect(message).toContain("fusion");
    expect(message).toContain("tts");
    expect(message).toContain(TTS_MODELS[0]);

    // The dedup assertion: a second identical dispatch must add nothing.
    const second = await dispatch({
      comboName: "dedup-tts-fusion",
      strategy: "fusion",
      models: TTS_MODELS,
      body: { model: "dedup-tts-fusion", input: "read this aloud" },
    });
    expect(second.res.status).toBe(200);
    expect(comboWarnings(second.log)).toHaveLength(0);
  });

  it("warns independently for a different combo / provider|model pair", async () => {
    await dispatch({
      comboName: "dedup-image-fusion",
      strategy: "fusion",
      models: ["google/imagen-3"],
      body: { model: "dedup-image-fusion", prompt: "a red panda" },
    });
    const other = await dispatch({
      comboName: "dedup-fetch-fusion",
      strategy: "fusion",
      models: ["jina/reader"],
      body: { provider: "dedup-fetch-fusion", url: "https://example.com" },
    });

    const warnings = comboWarnings(other.log);
    expect(warnings).toHaveLength(1);
    const [, message] = warnings[0];
    expect(message).toContain("dedup-fetch-fusion");
    expect(message).toContain("fetch");
    expect(message).toContain("jina/reader");
  });

  it("warns about a strategy outside the vocabulary", async () => {
    const { log, res } = await dispatch({
      comboName: "bad-vocab",
      strategy: "roundrobin",
      models: ["openai/gpt-4.1", "openai/gpt-4o"],
      body: { model: "bad-vocab", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.status).toBe(200);
    const warnings = comboWarnings(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toContain("roundrobin");
    expect(warnings[0][1]).toContain("fallback | round-robin | fusion");
  });

  it("stays silent for the strategies every modality can run", async () => {
    for (const [comboName, strategy, body] of [
      ["quiet-rr-tts", "round-robin", { model: "quiet-rr-tts", input: "read this aloud" }],
      ["quiet-rr-chat", "round-robin", { model: "quiet-rr-chat", messages: [{ role: "user", content: "hi" }] }],
      ["quiet-fb-image", "fallback", { model: "quiet-fb-image", prompt: "a red panda" }],
    ]) {
      const { log } = await dispatch({ comboName, strategy, models: TTS_MODELS, body });
      expect(comboWarnings(log)).toHaveLength(0);
    }
  });

  it("skips validation when the body shape is not a recognized modality", async () => {
    const { log, res } = await dispatch({
      comboName: "unknown-shape",
      strategy: "fusion",
      models: TTS_MODELS,
      body: { voice: "alloy", speed: 1.1 },
    });

    expect(res.status).toBe(200);
    expect(comboWarnings(log)).toHaveLength(0);
  });
});

// ── L1-6: modality strip warning ──────────────────────────────────────────────
function chatCoreOptions(provider, model) {
  const body = { model, messages: [{ role: "user", content: "hello" }] };
  return {
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

async function stripWarnings(provider, model) {
  const options = chatCoreOptions(provider, model);
  await handleChatCore(options);
  return options.log.warn.mock.calls.filter(([tag]) => tag === "MODALITY");
}

describe("capabilities strip warning (L1-6)", () => {
  it("warns once for a dropped modality and does not repeat it per request", async () => {
    getCapabilitiesForModel.mockReturnValue({ vision: false, pdf: true, audioInput: true });

    const first = await stripWarnings("strip-dedup-a", "text-only-1");
    expect(first).toHaveLength(1);
    const [, message] = first[0];
    expect(message).toContain("strip-dedup-a/text-only-1");
    expect(message).toContain("vision");

    const second = await stripWarnings("strip-dedup-a", "text-only-1");
    expect(second).toHaveLength(0);
  });

  it("warns independently for a different provider|model pair", async () => {
    getCapabilitiesForModel.mockReturnValue(NO_CAPS);

    const other = await stripWarnings("strip-dedup-b", "text-only-2");
    expect(other).toHaveLength(1);
    const [, message] = other[0];
    expect(message).toContain("strip-dedup-b/text-only-2");
    // One line per model, not one per capability.
    expect(message).toContain("vision / pdf / audioInput");
  });

  it("stays silent for a model that supports every strippable modality", async () => {
    getCapabilitiesForModel.mockReturnValue(ALL_CAPS);

    expect(await stripWarnings("strip-quiet", "omni-1")).toHaveLength(0);
  });
});
