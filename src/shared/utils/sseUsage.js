/**
 * Token usage extraction from an SSE stream — pure, DOM-free, JSX-free.
 *
 * Why this is not a component concern: the usage report and the answer text
 * arrive in *different* chunks. An OpenAI-format upstream that was asked for
 * `stream_options.include_usage` emits a final frame carrying `usage` with an
 * EMPTY `choices` array, so any loop that bails out on "no text in this chunk"
 * drops it. Every other provider instead reports usage in its own wire format
 * and the response translators *attach* it to the last content chunk (see
 * open-sse/translator/response/claude-to-openai.js). Both shapes are read here
 * by scanning the raw SSE text, which is the only place both are visible.
 *
 * Kept dependency-light and side-effect-free so it can be unit tested without a
 * component, a DOM, or a network.
 */

import { canonicalizeUsage } from "open-sse/utils/usageTracking.js";
import { calculateCostFromTokens, getPricingForModel } from "open-sse/providers/pricing.js";

const DATA_PREFIX = "data:";
// OpenAI's end-of-stream sentinel. It is not JSON and must never be parsed:
// JSON.parse("[DONE]") throws, and treating it as an error chunk would abort
// an otherwise complete stream. Skipping it is a pinned contract, not an
// accident — see tests/unit/playground-usage.test.js.
const DONE_SENTINEL = "[DONE]";

/**
 * Extract the usage report from raw SSE text.
 *
 * @param {string} text - Raw SSE payload, possibly several frames concatenated.
 * @returns {object|null} Canonical usage (prompt/completion/total/cached/
 *   cache_creation/reasoning tokens), or null when the stream carried no usage
 *   report at all.
 *
 * Notes on the failure modes this has to survive:
 * - "no usage" and "usage of 0" are different answers. A missing report is
 *   unknown, so it returns null; a report that is genuinely all zeros returns
 *   zeros. Never 0 and never NaN for the unknown case.
 * - A frame can be split across TCP reads. An unparseable payload is skipped
 *   rather than thrown, so the caller can re-feed the same text once the rest
 *   of the frame has arrived and still get the usage.
 * - Proxies rewrite bare "\n" to "\r\n", so line splitting accepts both (and
 *   a lone "\r", which the SSE spec also allows) and each line is trimmed
 *   before the "data:" test.
 * - Multiple usage frames resolve to the LAST one. The stream's final report
 *   is the one that accounts for the bytes the caller actually received;
 *   earlier frames belong to attempts (retry/fallback) whose output was
 *   discarded, and the last-writer-wins order is the same rule the usage
 *   store applies when one request reports more than once.
 */
export function extractUsageFromSSE(text) {
  if (typeof text !== "string" || text.length === 0) return null;

  let found = null;

  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(DATA_PREFIX)) continue;

    const payload = trimmed.slice(DATA_PREFIX.length).trim();
    if (!payload || payload === DONE_SENTINEL) continue;

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // Truncated frame (split TCP segment) or a non-JSON keep-alive line.
      continue;
    }

    const usage = canonicalizeUsage(chunk?.usage);
    if (usage) found = usage;
  }

  return found;
}

/**
 * Same answer as `extractUsageFromSSE`, for a caller that ALREADY has the frame
 * parsed.
 *
 * An SSE read loop must JSON.parse each frame anyway to read the assistant text,
 * so routing it back through extractUsageFromSSE re-splits the line, re-trims,
 * re-slices and JSON.parses the identical payload a second time — once per frame
 * of a streamed reply. Callers holding the parsed object should use this.
 *
 * @param {object} chunk - One already-parsed SSE frame.
 * @returns {object|null}
 */
export function usageFromChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  return canonicalizeUsage(chunk.usage);
}

/**
 * Cost in USD for a usage report.
 *
 * Returns a finite number for every input, including "no pricing known" and
 * "zero tokens" — a NaN here would render as "$NaN" in the UI. Callers that
 * need to tell "free" from "no price on file" should check getPricingForModel
 * themselves.
 */
export function estimateUsageCost(usage, { provider = "", model = "" } = {}) {
  if (!usage) return 0;

  const pricing = getPricingForModel(provider, model);
  const cost = calculateCostFromTokens(usage, pricing);
  return Number.isFinite(cost) ? cost : 0;
}

function formatTokenCount(value) {
  const n = Number.isFinite(Number(value)) ? Number(value) : 0;
  return n.toLocaleString("en-US");
}

// Sub-cent requests are the norm in a playground, so two decimals would print
// "$0.00" for a real request. Same shape as ModelPricingPageClient.
function formatCostUsd(cost) {
  const n = Number.isFinite(cost) ? cost : 0;
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * One-line, display-ready usage footnote. Returns "" for a missing report so
 * the caller can render nothing at all instead of a misleading "$0.00".
 */
export function formatUsageSummary(usage, { provider = "", model = "" } = {}) {
  if (!usage) return "";

  const input = usage.prompt_tokens || 0;
  const output = usage.completion_tokens || 0;
  const total = usage.total_tokens ?? (input + output);
  const cost = estimateUsageCost(usage, { provider, model });

  return `${formatTokenCount(input)} in · ${formatTokenCount(output)} out · ${formatTokenCount(total)} total · ${formatCostUsd(cost)}`;
}
