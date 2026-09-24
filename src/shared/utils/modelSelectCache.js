"use client";

// Shared in-memory cache for the model-selector catalog endpoints.
//
// The "Add Model to Combo" modal re-fetches the whole catalog every time it
// opens, which made it feel sluggish. This cache keeps those responses for a
// short TTL so reopening the modal paints instantly; the model-catalog SSE
// stream (/api/models/events) drops the cache when a provider/combo/model is
// edited elsewhere, and callers can force-refresh on demand.

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { data, expiresAt }

let catalogVersion = null;

// Drop every cached response, forcing the next read to hit the network.
export function invalidateModelSelectCache() {
  cache.clear();
}

// Track the server catalog version advertised by the SSE handshake. A version
// different from the last one seen means something changed while this client was
// disconnected, so the cache is dropped. Returns true when that happened.
export function syncCatalogVersion(version) {
  if (version == null) return false;
  const changed = catalogVersion !== null && catalogVersion !== version;
  catalogVersion = version;
  if (changed) cache.clear();
  return changed;
}

export async function fetchCachedJson(url, { force = false } = {}) {
  if (!force) {
    const hit = cache.get(url);
    if (hit && Date.now() < hit.expiresAt) return hit.data;
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache.set(url, { data, expiresAt: Date.now() + TTL_MS });
  return data;
}
