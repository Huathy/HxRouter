import { ContextCompressor } from "thincontext";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { resolveSessionId } from "../utils/sessionManager.js";

const COMPRESSIBLE_FORMATS = new Set(["openai", "claude", "openai-responses", "openai-response", "codex", "kiro"]);
const REPEATED_CONTENT_MARKER = "[repeated context omitted]";
const compressorPool = new Map();

function isResponsesFormat(format) {
  return format === "openai-responses" || format === "openai-response" || format === "codex";
}

function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}

function messagePayload(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  const kiro = collectKiroProjection(body);
  return kiro?.messages || null;
}

function captureSizeSnapshot(body) {
  const messages = messagePayload(body);
  return {
    bodyBytes: jsonBytes(body),
    messageBytes: messages ? jsonBytes(messages) : 0,
  };
}

function setDiagnostic(diagnostics, reason) {
  if (diagnostics && !diagnostics.reason) diagnostics.reason = reason;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (typeof part?.text === "string") parts.push(part.text);
    else if (Array.isArray(part?.text)) parts.push(part.text.filter((item) => typeof item === "string").join("\n"));
    else if (typeof part?.output === "string") parts.push(part.output);
    else if (Array.isArray(part?.output)) parts.push(part.output.filter((item) => typeof item === "string").join("\n"));
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function addProjection(projection, role, content, target, toolCallId = null) {
  if (typeof content !== "string" || content.length === 0 || !target) return;
  const message = { role, content };
  if (toolCallId) message.tool_call_id = toolCallId;
  projection.messages.push(message);
  projection.sources.push({ role, toolCallId: toolCallId || null });
  projection.targets.push(target);
}

function addFieldProjection(projection, role, object, key, toolCallId = null) {
  if (!object || typeof object[key] !== "string") return;
  addProjection(projection, role, object[key], { object, key }, toolCallId);
}

function buildMessageProjection(messages) {
  const projection = { messages: [], sources: [], targets: [] };
  if (!Array.isArray(messages)) return projection;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "tool";
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : null;
    if (typeof message.content === "string") {
      addFieldProjection(projection, role, message, "content", toolCallId);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part?.text === "string") {
        addProjection(projection, role, part.text, { object: part, key: "text" }, toolCallId);
      } else if (typeof part?.output === "string") {
        addProjection(projection, role, part.output, { object: part, key: "output" }, toolCallId);
      }
    }
  }
  return projection;
}

function collectKiroProjection(body) {
  const state = body?.conversationState;
  if (!state || typeof state !== "object") return null;
  const projection = { messages: [], sources: [], targets: [] };

  const visit = (item) => {
    const user = item?.userInputMessage;
    if (user) {
      addFieldProjection(projection, "system", user, "systemInstruction");
      addFieldProjection(projection, "user", user, "content");
      const toolResults = user.userInputMessageContext?.toolResults;
      if (Array.isArray(toolResults)) {
        for (const toolResult of toolResults) {
          const toolCallId = typeof toolResult?.toolUseId === "string" ? toolResult.toolUseId : null;
          if (toolResult?.content !== undefined) {
            const text = textFromContent(toolResult.content);
            if (text) {
              const textPart = Array.isArray(toolResult.content)
                ? toolResult.content.find((part) => typeof part?.text === "string" || Array.isArray(part?.text))
                : null;
              addProjection(
                projection,
                "tool",
                text,
                textPart
                  ? { object: textPart, key: "text", asArray: Array.isArray(textPart.text) }
                  : { object: toolResult, key: "content", asArray: Array.isArray(toolResult.content) },
                toolCallId,
              );
            }
          }
        }
      }
      return;
    }

    const assistant = item?.assistantResponseMessage;
    if (assistant) addFieldProjection(projection, "assistant", assistant, "content");
  };

  if (Array.isArray(state.history)) {
    for (const item of state.history) visit(item);
  }
  if (state.currentMessage) visit(state.currentMessage);
  return projection.messages.length > 0 ? projection : null;
}

function collectClaudeProjection(body) {
  const projection = { messages: [], sources: [], targets: [] };
  if (typeof body?.system === "string") {
    addFieldProjection(projection, "system", body, "system");
  } else if (Array.isArray(body?.system)) {
    for (const part of body.system) addProjection(projection, "system", part?.text, { object: part, key: "text" });
  }

  if (!Array.isArray(body?.messages)) return projection;
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      addFieldProjection(projection, role, message, "content");
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "text") {
        addProjection(projection, role, block.text, { object: block, key: "text" });
      } else if (block?.type === "tool_result") {
        const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (typeof block.content === "string") {
          addFieldProjection(projection, "tool", block, "content", toolCallId);
        } else if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part?.type === "text") addProjection(projection, "tool", part.text, { object: part, key: "text" }, toolCallId);
          }
        }
      }
    }
  }
  return projection;
}

function sameProjectionMessage(source, message) {
  if (!message || message.role !== source.role) return false;
  if (source.toolCallId && message.tool_call_id !== source.toolCallId) return false;
  return true;
}

function applyProjection(projection, compressedMessages, diagnostics) {
  if (!Array.isArray(compressedMessages)) {
    setDiagnostic(diagnostics, "compression returned invalid messages[]");
    return false;
  }

  const updates = [];
  let cursor = 0;
  for (let i = 0; i < projection.sources.length; i++) {
    const source = projection.sources[i];
    let match = -1;
    for (let j = cursor; j < compressedMessages.length; j++) {
      if (sameProjectionMessage(source, compressedMessages[j])) {
        match = j;
        break;
      }
    }

    if (match < 0) {
      if (source.role !== "system" && source.role !== "tool") {
        setDiagnostic(diagnostics, "compression changed user/assistant message structure");
        return false;
      }
      updates.push({ target: projection.targets[i], text: REPEATED_CONTENT_MARKER });
      projection.messages[i] = { ...projection.messages[i], content: REPEATED_CONTENT_MARKER };
      continue;
    }

    const text = textFromContent(compressedMessages[match].content);
    if (text === null) {
      setDiagnostic(diagnostics, "compression returned invalid message content");
      return false;
    }
    updates.push({ target: projection.targets[i], text });
    projection.messages[i] = { ...projection.messages[i], content: text };
    cursor = match + 1;
  }

  if (cursor < compressedMessages.length) {
    setDiagnostic(diagnostics, "compression returned unexpected messages[]");
    return false;
  }

  for (const update of updates) {
    update.target.object[update.target.key] = update.target.asArray ? [update.text] : update.text;
  }
  return true;
}

function hasUnsafeResponsesInputForCompression(body) {
  if (!Array.isArray(body?.input)) return false;
  return body.input.some((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.type === "string" && item.type !== "message");
}

function getCompressor(sessionKey) {
  const now = Date.now();
  for (const [key, entry] of compressorPool) {
    if (now - entry.lastUsed > MEMORY_CONFIG.compressionTtlMs) compressorPool.delete(key);
  }

  const existing = compressorPool.get(sessionKey);
  if (existing) {
    existing.lastUsed = now;
    return existing.compressor;
  }

  const compressor = new ContextCompressor({ dedup: { strategy: "hash" } });
  if (compressorPool.size >= MEMORY_CONFIG.compressionMaxSessions) {
    let oldestKey = null;
    let oldestUsed = Infinity;
    for (const [key, entry] of compressorPool) {
      if (entry.lastUsed < oldestUsed) {
        oldestKey = key;
        oldestUsed = entry.lastUsed;
      }
    }
    if (oldestKey) compressorPool.delete(oldestKey);
  }
  compressorPool.set(sessionKey, { compressor, lastUsed: now });
  return compressor;
}

async function compressProjection(projection, sessionKey) {
  if (projection.messages.length === 0) return null;
  const compressor = sessionKey ? getCompressor(sessionKey) : new ContextCompressor({ dedup: { strategy: "hash" } });
  const result = await compressor.compress(projection.messages);
  if (!result || !Array.isArray(result.messages) || !result.stats) return null;
  return result;
}

function statsFromThincontext(result) {
  const ratio = Number(result.stats.compressionRatio);
  return {
    engine: "thincontext",
    estimated: true,
    tokens_before: Number(result.stats.inputTokens) || 0,
    tokens_after: Number(result.stats.outputTokens) || 0,
    tokens_saved: Math.max(0, Number(result.stats.savedTokens) || 0),
    compression_ratio: Number.isFinite(ratio) ? ratio : 1,
  };
}

export function resolveCompressionSessionKey({ body, connectionId, headers, apiKeyInfo, apiKeyName } = {}) {
  const sessionId = resolveSessionId({ headers, body, connectionId, scope: "context-compression" });
  const tenant = apiKeyInfo?.id || apiKeyName || "local";
  return `${tenant}:${connectionId || "default"}:${sessionId}`;
}

export function clearContextCompressionState() {
  compressorPool.clear();
}

export async function compressContext(body, { enabled, format, model, sessionKey, sessionId, signal, diagnostics = null } = {}) {
  if (!enabled) {
    setDiagnostic(diagnostics, "disabled");
    return null;
  }
  if (signal?.aborted) {
    setDiagnostic(diagnostics, "client aborted before compression");
    return null;
  }
  if (!body || !COMPRESSIBLE_FORMATS.has(format)) {
    setDiagnostic(diagnostics, `unsupported ${format || "unknown"} request shape`);
    return null;
  }
  if (isResponsesFormat(format) && hasUnsafeResponsesInputForCompression(body)) {
    setDiagnostic(diagnostics, "skipped: openai-responses tool/reasoning input is not safe to compress");
    return null;
  }

  const effectiveSessionKey = sessionKey || sessionId;
  try {
    if (diagnostics) diagnostics.before = captureSizeSnapshot(body);
    let projection;
    let responseSource = null;
    let responseTransform = null;

    if (format === "kiro") {
      projection = collectKiroProjection(body);
    } else if (format === "claude") {
      projection = collectClaudeProjection(body);
    } else if (isResponsesFormat(format)) {
      const { openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest } = await import("../translator/request/openai-responses.js");
      responseTransform = openaiToOpenAIResponsesRequest;
      responseSource = openaiResponsesToOpenAIRequest(model, body, false);
      if (!Array.isArray(responseSource?.messages)) {
        setDiagnostic(diagnostics, "openai-responses request did not translate to messages[]");
        return null;
      }
      projection = buildMessageProjection(responseSource.messages);
    } else {
      const messages = Array.isArray(body.messages) ? body.messages : body.input;
      projection = buildMessageProjection(messages);
    }

    if (!projection || projection.messages.length === 0) {
      setDiagnostic(diagnostics, "request has no compressible message text");
      return null;
    }

    const result = await compressProjection(projection, effectiveSessionKey);
    if (!result || !result.stats) {
      setDiagnostic(diagnostics, "compression returned no statistics");
      return null;
    }
    if (Number(result.stats.savedTokens) <= 0) {
      setDiagnostic(diagnostics, "compression found no token savings");
      return null;
    }
    if (signal?.aborted) {
      setDiagnostic(diagnostics, "client aborted during compression");
      return null;
    }
    if (!applyProjection(projection, result.messages, diagnostics)) return null;

    if (isResponsesFormat(format)) {
      const responsesBody = responseTransform(
        model,
        { ...responseSource, input: undefined, messages: projection.messages },
        false,
      );
      if (!Array.isArray(responsesBody?.input)) {
        setDiagnostic(diagnostics, "compression could not preserve Responses input[]");
        return null;
      }
      body.input = responsesBody.input;
    }

    if (diagnostics) diagnostics.after = captureSizeSnapshot(body);
    return statsFromThincontext(result);
  } catch (error) {
    setDiagnostic(diagnostics, `unexpected error: ${error?.message || String(error)}`);
    return null;
  }
}

export function formatCompressionLog(stats) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const delta = stats.tokens_saved || 0;
  const pct = before > 0 ? ((delta / before) * 100).toFixed(1) : "0";
  return `estimated token delta=${delta} before=${before}${after ? ` after=${after}` : ""} (${pct}%)`.trim();
}

export function formatCompressionSizeLog(diagnostics) {
  const before = diagnostics?.before;
  const after = diagnostics?.after;
  if (!before || !after) return "";
  return `body=${before.bodyBytes}B→${after.bodyBytes}B messages=${before.messageBytes}B→${after.messageBytes}B`;
}

export function isCompressionPhantomSavings(stats, diagnostics, minShrinkRatio = 0.05) {
  if (!stats?.tokens_saved || stats.tokens_saved <= 0) return false;
  const before = diagnostics?.before?.bodyBytes || 0;
  const after = diagnostics?.after?.bodyBytes || 0;
  if (before <= 0 || after <= 0) return false;
  return after > before * (1 - minShrinkRatio);
}
