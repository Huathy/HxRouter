// Shared Kilo Code free-model catalog access.
//
// The cache layer always stores the FULL upstream free catalog; "enabled"
// (i.e. minus user-disabled ids) is applied on read so disabled edits take
// effect immediately without waiting for the cache to expire.

import { getDisabledByProvider } from "@/lib/disabledModelsDb";

const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedModels = null; // full free list, refreshed only on (re)fetch
let cacheTimestamp = 0;

export function isKiloFreeModelsCacheFresh() {
  return Boolean(cachedModels) && Date.now() - cacheTimestamp < CACHE_TTL_MS;
}

// Returns the full free catalog (NOT filtered by disabled state).
export async function fetchKiloFreeModels({ refresh = false } = {}) {
  if (!refresh && isKiloFreeModelsCacheFresh()) {
    return cachedModels;
  }

  try {
    const res = await fetch(KILO_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return cachedModels || [];

    const json = await res.json();
    cachedModels = (json.data || [])
      .filter((m) => m.isFree === true && m.id)
      .map((m) => ({ id: m.id, name: m.name, isFree: true, context_length: m.context_length || 0 }));
    cacheTimestamp = Date.now();
    return cachedModels;
  } catch {
    // Fail-open: degrade to the last successful catalog (or empty).
    return cachedModels || [];
  }
}

// Returns the free catalog minus user-disabled ids (immediate, no cache required).
export async function fetchEnabledKiloFreeModels({ refresh = false } = {}) {
  const [kcDisabled, kilocodeDisabled] = await Promise.all([
    getDisabledByProvider("kc"),
    getDisabledByProvider("kilocode"),
  ]);
  const disabled = new Set([...kcDisabled, ...kilocodeDisabled]);
  const all = await fetchKiloFreeModels({ refresh });
  return all.filter((m) => m?.id && !disabled.has(m.id));
}
