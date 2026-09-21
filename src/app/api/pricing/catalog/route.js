import { NextResponse } from "next/server";
import { getPricing } from "@/lib/localDb.js";
import { LAB_SOURCES, getLastSyncMeta } from "@/lib/pricingCatalog/sync.js";

/**
 * GET /api/pricing/catalog
 * Pricing table for the dashboard: every synced model with its rates,
 * flattened for display, plus the last models.dev sync time.
 */
export async function GET() {
  try {
    const [pricing, lastSync] = await Promise.all([getPricing(), getLastSyncMeta()]);
    const trackedProviders = new Set(LAB_SOURCES.map((s) => s.provider));

    const models = [];
    for (const [provider, entries] of Object.entries(pricing)) {
      if (!trackedProviders.has(provider)) continue;
      for (const [model, rates] of Object.entries(entries)) {
        if (!rates || typeof rates.input !== "number") continue;
        models.push({
          provider,
          model,
          input: rates.input,
          output: rates.output,
          cached: rates.cached ?? null,
          cacheCreation: rates.cache_creation ?? null,
          reasoning: rates.reasoning ?? null,
        });
      }
    }
    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

    return NextResponse.json({
      models,
      lastSync,
      intervalMs: 6 * 60 * 60 * 1000,
    });
  } catch (error) {
    console.error("Error fetching pricing catalog:", error);
    return NextResponse.json({ error: "Failed to fetch pricing catalog" }, { status: 500 });
  }
}
