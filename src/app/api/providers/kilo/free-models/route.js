import { NextResponse } from "next/server";
import {
  fetchEnabledKiloFreeModels,
  fetchKiloFreeModels,
  isKiloFreeModelsCacheFresh,
} from "@/lib/kiloFreeModels";

// GET /api/providers/kilo/free-models
//   (default)   -> enabled free models (full catalog minus disabled ids)
//   ?all=1      -> full free catalog (for the provider detail page Disabled list)
//   ?refresh=1  -> bypass the in-memory cache and re-fetch upstream
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get("refresh") === "1";
  const includeAll = searchParams.get("all") === "1";
  const cached = !forceRefresh && isKiloFreeModelsCacheFresh();

  try {
    const models = includeAll
      ? await fetchKiloFreeModels({ refresh: forceRefresh })
      : await fetchEnabledKiloFreeModels({ refresh: forceRefresh });
    return NextResponse.json({ models, cached });
  } catch (error) {
    return NextResponse.json(
      { models: [], error: `Failed to fetch Kilo models: ${error.message}` },
      { status: 502 }
    );
  }
}
