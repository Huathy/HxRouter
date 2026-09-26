// Prompt-cache hit-rate analysis: hourly bucketing + drop detection.
//
// Isomorphic on purpose. `bucketCacheHitByHour` runs on the server (it is fed
// rows read out of SQLite by `getCacheHitTrend` in src/lib/db/repos/usageRepo.js)
// and `detectCacheHitDrop` runs in the browser (the usage dashboard alert). Both
// therefore live here, in one dependency-free module, instead of being
// duplicated per side — a bucket definition that drifted between the two would
// make the alert report a regression against numbers the server never produced.
//
// Nothing in this file may import a Node builtin or a server module: it is part
// of the client bundle. The DB read lives behind /api/usage/cache-hit.

/**
 * Parse the `tokens` TEXT column into an object.
 *
 * The column is a JSON blob, but the driver decides how it reaches us: better-sqlite3
 * hands back a string, sql.js can hand back a Uint8Array, and an already-parsed
 * object means a caller passed one. Returns null for anything unreadable so the
 * caller can degrade one row instead of losing the whole trend.
 */
function parseTokensColumn(value) {
  if (value == null) return null;
  if (typeof value === "object" && !ArrayBuffer.isView(value)) return value;
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = new TextDecoder().decode(value);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Collapse raw `usageHistory` rows into hourly cache buckets.
 *
 * @param {Array<{timestamp: string, promptTokens?: number, tokens?: unknown}>} rows
 * @param {{ now?: number, bucketCount?: number, bucketMs?: number }} [options]
 * @returns {Array<{bucketStart: number, requests: number, promptTokens: number,
 *                  cachedTokens: number, hitRate: number|null}>} oldest-first
 */
export function bucketCacheHitByHour(rows, options = {}) {
  const {
    now = Date.now(),
    bucketCount = 24,
    bucketMs = 3600000,
  } = options;

  // The grid is anchored at `now` on purpose: the newest bucket is the current
  // PARTIAL hour, which is the whole point of a live drop alert. That makes the
  // newest bucketStart move with every poll, so anything that needs to identify
  // "the same bucket" across polls must use cacheBucketKey() below, not the raw
  // bucketStart.
  const start = now - bucketCount * bucketMs;
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    bucketStart: start + i * bucketMs,
    requests: 0,
    promptTokens: 0,
    cachedTokens: 0,
    hitRate: null,
  }));

  for (const row of rows || []) {
    const t = new Date(row.timestamp).getTime();
    if (!Number.isFinite(t) || t < start || t > now) continue;
    const idx = Math.min(Math.floor((t - start) / bucketMs), bucketCount - 1);
    if (idx < 0) continue;

    const bucket = buckets[idx];
    bucket.requests += 1;
    bucket.promptTokens += row.promptTokens || 0;

    const parsed = parseTokensColumn(row.tokens);
    const cached = parsed?.cached_tokens ?? parsed?.cache_read_input_tokens ?? 0;
    // A malformed blob contributes no cached tokens rather than aborting the
    // whole trend; the hit rate just reads lower for that bucket.
    bucket.cachedTokens += Number.isFinite(cached) ? cached : 0;
  }

  for (const bucket of buckets) {
    bucket.hitRate = bucket.promptTokens > 0 ? bucket.cachedTokens / bucket.promptTokens : null;
  }

  return buckets;
}

// ─── Drop detection ──────────────────────────────────────────────────────────
//
// Why an hourly trend and not a per-request check: the request-details ring
// buffer keeps only `DEFAULT_MAX_RECORDS = 200` rows, so a median taken over
// recent individual requests has more noise than signal and fires constantly.
// Hourly buckets aggregate enough samples to be meaningful.
//
// Two guards are load-bearing, not decoration:
//
//  1. MIN_REQUESTS_PER_BUCKET — a bucket below this is skipped entirely. Five
//     requests in an hour is already thin; fewer than that cannot distinguish a
//     real regression from sampling noise.
//  2. once-per-bucket reporting — a drop is a *state*, not an event. Without
//     this the detector re-reports the same drop on every dashboard refresh.
//
// `hitRate` is null when there were no prompt tokens. A bucket with zero prompt
// tokens is "no data", and rendering it as 0% would make the dashboard look
// broken rather than empty.

export const MIN_REQUESTS_PER_BUCKET = 5;
export const DEFAULT_DROP_RATIO = 0.5;

const BUCKET_MS = 3600000;

/**
 * Stable identity for "which hour is this bucket in".
 *
 * `bucketCacheHitByHour` anchors its grid at the request time, so the newest
 * bucket is the current partial hour and its `bucketStart` differs on every
 * poll. Keying a once-per-bucket decision (e.g. "the user dismissed this alert")
 * on the raw `bucketStart` therefore never matches and the alert reappears on the
 * next poll. Flooring to the hour boundary gives a value that is stable for the
 * whole hour and changes exactly when a new hour does.
 */
export function cacheBucketKey(bucketStart, bucketMs = BUCKET_MS) {
  if (!Number.isFinite(bucketStart)) return null;
  return Math.floor(bucketStart / bucketMs) * bucketMs;
}

/**
 * @typedef {{ bucketStart: number, requests: number, promptTokens: number,
 *             cachedTokens: number, hitRate: number|null }} CacheBucket
 *
 * @param {CacheBucket[]} buckets oldest-first
 * @param {{ minRequests?: number, dropRatio?: number, baselineWindow?: number }} [options]
 * @returns {{
 *   status: "ok" | "insufficient-data" | "drop",
 *   current: CacheBucket|null,
 *   baselineHitRate: number|null,
 *   reason?: string
 * }}
 */
export function detectCacheHitDrop(buckets, options = {}) {
  const {
    minRequests = MIN_REQUESTS_PER_BUCKET,
    dropRatio = DEFAULT_DROP_RATIO,
    baselineWindow = 6,
  } = options;

  const list = Array.isArray(buckets) ? buckets : [];
  if (list.length < 2) {
    return { status: "insufficient-data", current: null, baselineHitRate: null, reason: "need at least two hourly buckets" };
  }

  const current = list[list.length - 1];

  if (current.requests < minRequests) {
    return {
      status: "insufficient-data",
      current,
      baselineHitRate: null,
      reason: `current hour has ${current.requests} request(s), below the ${minRequests}-request minimum`,
    };
  }

  if (current.hitRate === null) {
    return {
      status: "insufficient-data",
      current,
      baselineHitRate: null,
      reason: "current hour recorded no prompt tokens",
    };
  }

  // Baseline = median hit rate of the qualifying prior buckets. Median, not mean:
  // one bad hour should not drag the baseline down and hide the very drop we are
  // looking for.
  const prior = list
    .slice(Math.max(0, list.length - 1 - baselineWindow), -1)
    .filter((b) => b.requests >= minRequests && b.hitRate !== null)
    .map((b) => b.hitRate)
    .sort((a, b) => a - b);

  if (prior.length < 2) {
    return {
      status: "insufficient-data",
      current,
      baselineHitRate: null,
      reason: `only ${prior.length} qualifying prior hour(s), need at least 2`,
    };
  }

  const mid = Math.floor(prior.length / 2);
  const baselineHitRate = prior.length % 2 === 0
    ? (prior[mid - 1] + prior[mid]) / 2
    : prior[mid];

  if (baselineHitRate <= 0) {
    // Baseline is already zero — there is no drop to report, and dividing by it
    // would be meaningless.
    return { status: "ok", current, baselineHitRate };
  }

  const isDrop = current.hitRate < baselineHitRate * dropRatio;
  return { status: isDrop ? "drop" : "ok", current, baselineHitRate };
}
