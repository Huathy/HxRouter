import { NextResponse } from "next/server";
import { getCacheHitTrend } from "@/lib/usageDb";

// Hourly prompt-cache hit trend. The dashboard alert polls this instead of
// reading the DB from the browser: `usageRepo` pulls in the SQLite driver and
// `undici`, which cannot be bundled for the client.
const MIN_HOURS = 1;
// `detectCacheHitDrop` consumes a baselineWindow of 6 prior hours plus the
// current one, so 12 is the real ceiling. The old 168 (7 days) let one request
// pull a week out of `usageHistory` — a table with no retention job — on a
// route the dashboard only ever calls with hours=24.
const MAX_HOURS = 12;
const DEFAULT_HOURS = 12;

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = Number.parseInt(searchParams.get("hours") || "", 10);
    const hours = Number.isFinite(raw) ? Math.min(Math.max(raw, MIN_HOURS), MAX_HOURS) : DEFAULT_HOURS;

    const buckets = await getCacheHitTrend(hours);
    return NextResponse.json(buckets);
  } catch (error) {
    console.error("[API] Failed to get cache hit trend:", error);
    return NextResponse.json({ error: "Failed to fetch cache hit trend" }, { status: 500 });
  }
}
