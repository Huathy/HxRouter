// Periodic refresh of model pricing from models.dev.
//
// models.dev serves lab-direct prices on each lab's provider page (e.g.
// /providers/anthropic shows the prices Anthropic itself charges). This module
// fetches those pages, extracts "$input / $output" per 1M tokens per model,
// derives the cached/reasoning/cache_creation rates from per-lab conventions,
// and writes the result into the user pricing KV store (pricingRepo) so it
// overrides the hand-written MODEL_PRICING table.
//
// Failures are swallowed on purpose: stale prices are better than no prices.
// Disable entirely with PRICING_SYNC=off.

const MODELS_DEV_BASE = "https://models.dev/providers";
const FETCH_TIMEOUT_MS = 60000;

// 9router provider id -> models.dev provider (lab) id. Only labs whose prices
// 9router tracks directly; everything else keeps the hand-written tables.
export const LAB_SOURCES = [
  { provider: "anthropic", lab: "anthropic", family: "claude" },
  { provider: "openai", lab: "openai", family: "gpt" },
  { provider: "google", lab: "google", family: "gemini" },
  { provider: "deepseek", lab: "deepseek", family: "deepseek" },
  { provider: "kimi", lab: "moonshotai", family: "kimi" },
  { provider: "kimi-cn", lab: "moonshotai-cn", family: "kimi" },
  { provider: "glm", lab: "zai", family: "glm" },
  { provider: "glm-cn", lab: "zhipuai", family: "glm" },
  { provider: "qwen", lab: "alibaba", family: "qwen" },
  { provider: "qwen-cn", lab: "alibaba-cn", family: "qwen" },
  { provider: "minimax", lab: "minimax", family: "minimax" },
  { provider: "minimax-cn", lab: "minimax-cn", family: "minimax" },
  { provider: "xai", lab: "xai", family: "grok" },
];

// models.dev only publishes input/output. These fill cached/reasoning/
// cache_creation so a DB override does not degrade the fallback chain in
// open-sse/providers/pricing.js (which otherwise charges cached input at full
// rate). Ratios follow each lab's own published discount, as already encoded
// in MODEL_PRICING.
const LAB_CACHED_RATIO = {
  claude: 0.1,    // Anthropic: cache reads are 10% of base input
  gpt: 0.1,       // OpenAI current generation (gpt-5.2+); older 0.5
  gemini: 0.1,    // Google: implicit caching, 10-25% depending on model
  deepseek: 0.02, // DeepSeek: cache hits are ~2% of base input
  kimi: 0.2,      // Moonshot: cache hit ~20% of base input
  glm: 0.5,       // Zhipu: cache hit ~50% of base input
  qwen: 0.5,      // Alibaba: cache hit ~50% of base input
  minimax: 0.5,   // MiniMax: cache hit ~50% of base input
  grok: 0.5,      // xAI: cache hit ~50% of base input
};
const CACHE_CREATION_RATIO = {
  claude: 1.25, // Anthropic: 5m cache writes are 125% of base input
};

// Skip models whose price would be misleading: $0.00 means "bundled in a
// subscription" (coding plans, preview access) — recording it would zero out
// real usage costs.
function isFreePlanPrice(input, output) {
  return input === 0 && output === 0;
}

// "claude-opus-4-6" -> "claude-opus-4-6" (dates kept: 9router ids include them)
function normalizeModelId(id) {
  return id.trim();
}

// Extract model id + "$in / $out" pairs from one provider page's table rows.
// Row shape (verified 2026-09 against models.dev HTML):
//   <tr data-search="..."><td ...><a class="primary-link" href="/models/lab/id">Name</a>...
//   <span class="copy-source">model-id</span>...
//   <td data-sort="N">$in / $out</td>...
// Returns [{ modelId, input, output }] — rows without a price are skipped.
export function parseProviderPage(html) {
  const out = [];
  const rows = html.split(/<tr data-search=/).slice(1);
  for (const row of rows) {
    const rowHtml = row.slice(0, row.indexOf("</tr>") + 5);
    const idMatch = rowHtml.match(/<span class="copy-source">([^<]+)<\/span>/);
    if (!idMatch) continue;
    const priceMatch = rowHtml.match(/<td data-sort="[\d.]+">\$([\d.]+) \/ \$([\d.]+)<\/td>/);
    if (!priceMatch) continue;
    const input = parseFloat(priceMatch[1]);
    const output = parseFloat(priceMatch[2]);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    out.push({ modelId: normalizeModelId(idMatch[1]), input, output });
  }
  return out;
}

export function buildPricing(family, input, output) {
  const cachedRatio = LAB_CACHED_RATIO[family] ?? 0.5;
  const creationRatio = CACHE_CREATION_RATIO[family] ?? cachedRatio;
  return {
    input,
    output,
    cached: round4(input * cachedRatio),
    reasoning: output,
    cache_creation: round4(input * creationRatio),
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export async function fetchLabPrices(lab) {
  const response = await fetch(`${MODELS_DEV_BASE}/${lab}`, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${lab}`);
  return response.text();
}

// Run one sync. Returns a summary, or null when it could not complete.
export async function syncModelPricing() {
  const { updatePricing } = await import("@/lib/db/repos/pricingRepo.js");

  const results = [];
  const payload = {};
  let models = 0;
  let failed = 0;

  for (const { provider, lab, family } of LAB_SOURCES) {
    try {
      const html = await fetchLabPrices(lab);
      const entries = parseProviderPage(html);
      const byModel = {};
      for (const { modelId, input, output } of entries) {
        if (isFreePlanPrice(input, output)) continue;
        byModel[modelId] = buildPricing(family, input, output);
        models++;
      }
      if (Object.keys(byModel).length) payload[provider] = byModel;
      results.push({ lab, models: entries.length });
    } catch (e) {
      failed++;
      results.push({ lab, error: e?.message || String(e) });
    }
  }

  if (!Object.keys(payload).length) {
    console.log(`[pricingSync] nothing to write (${failed}/${LAB_SOURCES.length} labs failed)`);
    return { status: failed ? "failed" : "empty", results };
  }

  // Sequential (not parallel) fetches already finished; a single merge write.
  await updatePricing(payload);
  // Record the sync timestamp next to the prices so the dashboard can show it.
  const { makeKv } = await import("@/lib/db/helpers/kvStore.js");
  await makeKv("pricing-meta").set("lastSync", { at: Date.now(), models, providers: Object.keys(payload).length });
  console.log(`[pricingSync] ${models} model prices across ${Object.keys(payload).length} providers (${failed} labs failed)`);
  return { status: "updated", models, providers: Object.keys(payload).length, results };
}

let timer = null;

// Last successful sync metadata, for the dashboard pricing table.
export async function getLastSyncMeta() {
  try {
    const { makeKv } = await import("@/lib/db/helpers/kvStore.js");
    return (await makeKv("pricing-meta").get("lastSync")) || null;
  } catch {
    return null;
  }
}

// 6h cadence: prices move at most weekly per lab, but three daily pulls (the
// original 9/12/17 request) collapse to the same cadence with less risk of
// rate-limiting. Disable with PRICING_SYNC=off.
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000; // let the server boot and serve first requests
const RETRY_DELAY_MS = 30 * 60 * 1000;

// Schedule the recurring sync. Follows the modelCatalog/sync.js pattern.
export function startModelPricingSync() {
  if (timer) return;
  if (String(process.env.PRICING_SYNC || "").toLowerCase() === "off") return;

  const schedule = (delay) => {
    timer = setTimeout(async () => {
      timer = null;
      const result = await syncModelPricing().catch((e) => {
        console.log(`[pricingSync] sync failed: ${e?.message || e}`);
        return null;
      });
      schedule(result ? SYNC_INTERVAL_MS : RETRY_DELAY_MS);
    }, delay);
    timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS);
}
