import { describe, expect, it } from "vitest";
import {
  clearContextCompressionState,
  compressContext,
  formatCompressionLog,
  isCompressionPhantomSavings,
} from "../../open-sse/rtk/contextCompression.js";

describe("local context compression", () => {
  it("does nothing when disabled", async () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const original = structuredClone(body);

    const result = await compressContext(body, {
      enabled: false,
      format: "openai",
      sessionKey: "disabled",
    });

    expect(result).toBeNull();
    expect(body).toEqual(original);
  });

  it("deduplicates repeated tool context without changing message count or tool id", async () => {
    clearContextCompressionState();
    const content = "repeated tool output";
    const first = { messages: [{ role: "tool", tool_call_id: "call-1", content }] };
    const second = { messages: [{ role: "tool", tool_call_id: "call-1", content }] };

    await compressContext(first, { enabled: true, format: "openai", sessionKey: "tenant:conn:one" });
    const result = await compressContext(second, { enabled: true, format: "openai", sessionKey: "tenant:conn:one" });

    expect(result.tokens_saved).toBeGreaterThan(0);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].tool_call_id).toBe("call-1");
    expect(second.messages[0].content).not.toBe(content);
  });

  it("does not compress after the client signal is aborted", async () => {
    clearContextCompressionState();
    const body = { messages: [{ role: "tool", tool_call_id: "call-1", content: "repeated tool output" }] };
    const original = structuredClone(body);
    const controller = new AbortController();
    controller.abort();

    const result = await compressContext(body, {
      enabled: true,
      format: "openai",
      sessionKey: "tenant:conn:aborted",
      signal: controller.signal,
    });

    expect(result).toBeNull();
    expect(body).toEqual(original);
  });

  it("keeps compressor state isolated between sessions", async () => {
    clearContextCompressionState();
    const content = "tenant-specific tool output";
    const first = { messages: [{ role: "tool", tool_call_id: "call-1", content }] };
    const second = { messages: [{ role: "tool", tool_call_id: "call-1", content }] };

    await compressContext(first, { enabled: true, format: "openai", sessionKey: "tenant-a:conn:one" });
    const result = await compressContext(second, { enabled: true, format: "openai", sessionKey: "tenant-b:conn:one" });

    expect(result).toBeNull();
    expect(second.messages[0].content).toBe(content);
  });

  it("keeps Claude system and message structure intact", async () => {
    clearContextCompressionState();
    const makeBody = () => ({
      system: [{ type: "text", text: "system instructions" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    const first = makeBody();
    const body = makeBody();
    const original = structuredClone(body);

    await compressContext(first, {
      enabled: true,
      format: "claude",
      sessionKey: "tenant:conn:claude",
    });
    const result = await compressContext(body, {
      enabled: true,
      format: "claude",
      sessionKey: "tenant:conn:claude",
    });

    expect(result.tokens_saved).toBeGreaterThan(0);
    expect(body.system[0].text).toBe("[repeated context omitted]");
    expect(body.messages).toHaveLength(original.messages.length);
    expect(body.messages[0].content[0].type).toBe("text");
  });

  it("preserves Kiro tool result structure while replacing repeated context", async () => {
    clearContextCompressionState();
    const content = "repeated kiro tool output";
    const makeBody = () => ({
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: "continue",
            userInputMessageContext: {
              toolResults: [{ toolUseId: "kiro-1", content: [{ text: [content] }] }],
            },
          },
        },
        history: [],
      },
    });

    await compressContext(makeBody(), { enabled: true, format: "kiro", sessionKey: "tenant:conn:kiro" });
    const body = makeBody();
    const result = await compressContext(body, { enabled: true, format: "kiro", sessionKey: "tenant:conn:kiro" });
    const toolResult = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0];

    expect(result.tokens_saved).toBeGreaterThan(0);
    expect(toolResult.toolUseId).toBe("kiro-1");
    expect(toolResult.content[0].text).toEqual(["[repeated context omitted]"]);
  });

  it("skips unsafe Codex Responses items", async () => {
    const body = {
      input: [{ type: "function_call", call_id: "call-1", name: "test", arguments: "{}" }],
    };
    const original = structuredClone(body);

    const result = await compressContext(body, {
      enabled: true,
      format: "codex",
      model: "gpt-5",
      sessionKey: "tenant:conn:codex",
    });

    expect(result).toBeNull();
    expect(body).toEqual(original);
  });

  it("keeps OpenAI Responses input items in Responses format", async () => {
    clearContextCompressionState();
    const makeBody = () => ({
      model: "gpt-5",
      input: [{
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "system instructions" }],
      }],
    });
    const first = makeBody();
    const body = makeBody();

    await compressContext(first, {
      enabled: true,
      format: "openai-responses",
      model: "gpt-5",
      sessionKey: "tenant:conn:responses",
    });
    const result = await compressContext(body, {
      enabled: true,
      format: "openai-responses",
      model: "gpt-5",
      sessionKey: "tenant:conn:responses",
    });

    expect(result.tokens_saved).toBeGreaterThan(0);
    expect(body.input[0].type).toBe("message");
    expect(body.input[0].content[0].type).toBe("input_text");
  });

  it("skips unsupported request formats", async () => {
    const body = { contents: [{ parts: [{ text: "hello" }] }] };
    const original = structuredClone(body);

    const result = await compressContext(body, {
      enabled: true,
      format: "gemini",
      sessionKey: "tenant:conn:unsupported",
    });

    expect(result).toBeNull();
    expect(body).toEqual(original);
  });

  it("formats token estimates and detects phantom savings", () => {
    expect(formatCompressionLog({ tokens_before: 100, tokens_after: 25, tokens_saved: 75 }))
      .toBe("estimated token delta=75 before=100 after=25 (75.0%)");
    expect(isCompressionPhantomSavings(
      { tokens_saved: 100 },
      { before: { bodyBytes: 1000 }, after: { bodyBytes: 990 } },
    )).toBe(true);
    expect(isCompressionPhantomSavings(
      { tokens_saved: 100 },
      { before: { bodyBytes: 1000 }, after: { bodyBytes: 950 } },
    )).toBe(false);
  });
});
